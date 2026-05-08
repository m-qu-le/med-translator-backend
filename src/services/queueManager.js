import { EventEmitter } from 'events';
import fs from 'fs';
import { processPdf } from './pdfService.js';
import { processTranslation } from './geminiService.js';
import Job from '../models/jobModel.js'; 
import System from '../models/systemModel.js'; // [THÊM MỚI] Import model System

export class QueueManager extends EventEmitter {
    constructor() {
        super();
        this.isProcessing = false;
        
        // [CƠ CHẾ CIRCUIT BREAKER]
        this.consecutiveFailures = 0;   
        this.isHibernating = false;     
        this.hibernationLevel = 1;      
        
        // Dữ liệu giám sát ngủ đông để gửi cho Frontend
        this.hibernationCount = 0; 
        this.hibernationStats = null; 
        
        // Lưu trữ tham chiếu Timeout để hủy khi cần Ép thức dậy
        this.hibernationTimer = null; 
    }

    async initDB() {
        try {
            // 1. Khôi phục Jobs
            const result = await Job.updateMany({ status: 'processing' }, { $set: { status: 'pending' } });
            if (result.modifiedCount > 0) {
                console.log(`♻️ [QUEUE] Đã khôi phục ${result.modifiedCount} tác vụ (Zombie Jobs) về trạng thái Pending.`);
            }

            // 2. [QUAN TRỌNG] Khôi phục trạng thái Ngủ đông từ Database
            const sysState = await System.findOne({ key: 'circuit_breaker' });
            if (sysState && sysState.isHibernating) {
                const now = new Date();
                const wakeupTime = new Date(sysState.stats.wakeupTime);

                if (wakeupTime > now) {
                    // Nếu vẫn chưa đến giờ thức dậy, thiết lập lại bộ đếm ngủ đông
                    this.isHibernating = true;
                    this.hibernationStats = sysState.stats;
                    this.hibernationCount = sysState.stats.hibernationCount;

                    const remainingMs = wakeupTime - now;
                    this.hibernationTimer = setTimeout(() => this.wakeUp(), remainingMs);
                    console.log(`🛑 [RESTORE] Hệ thống vẫn đang trong thời gian ngủ đông. Sẽ thức dậy sau ${Math.round(remainingMs/60000)} phút.`);
                } else {
                    // Nếu đã quá giờ thức dậy trong lúc server đang tắt, ép thức dậy luôn
                    await this.forceWakeUp();
                }
            }

            this.startFailedJobsSweeper();
            this.startWorker(); 
        } catch (error) {
            console.error('❌ [QUEUE] Lỗi khi khởi tạo DB:', error);
        }
    }

    // API Nội bộ cho Controller lấy trạng thái hiện tại
    getSystemStatus() {
        return {
            isHibernating: this.isHibernating,
            stats: this.hibernationStats
        };
    }

    // Hàm ép hệ thống thức dậy ngay lập tức
    async forceWakeUp() {
        if (!this.isHibernating) return false;

        console.log(`\n⚡ [CIRCUIT BREAKER] ÉP THỨC DẬY THỦ CÔNG (FORCE WAKE-UP)!`);
        
        if (this.hibernationTimer) clearTimeout(this.hibernationTimer);
        await this.wakeUp(); // Tái sử dụng hàm wakeUp
        return true;
    }

    startFailedJobsSweeper() {
        setInterval(async () => {
            if (this.isHibernating) return; 
            try {
                const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
                
                // [CẬP NHẬT FIX LỖI] Bỏ qua các tác vụ bị mất file vật lý để ngăn chặn Zombie Loop
                const result = await Job.updateMany(
                    { 
                        status: 'failed', 
                        updatedAt: { $lte: thirtyMinsAgo },
                        error: { $ne: 'File gốc bị mất do Server khởi động lại. Vui lòng dọn dẹp và tải lại.' } 
                    },
                    { $set: { status: 'pending', error: '🔄 Tự động thử lại sau 30 phút...' } }
                );
                
                if (result.modifiedCount > 0) {
                    console.log(`\n♻️ [AUTO-RECOVERY] Đã tìm thấy và đưa ${result.modifiedCount} files bị lỗi tạm thời quay lại hàng đợi.`);
                    this.startWorker(); 
                }
            } catch (error) {
                console.error('❌ [AUTO-RECOVERY] Lỗi khi truy vấn Database:', error.message);
            }
        }, 15 * 60 * 1000);
    }

    async triggerHibernation() {
        this.isHibernating = true; 
        this.hibernationCount++;
        
        const sleepHours = 4; // Cố định ngủ 4 tiếng
        const sleepMs = sleepHours * 60 * 60 * 1000;
        
        // Lưu chuẩn ISO để Frontend tự parse theo múi giờ địa phương
        this.hibernationStats = {
            startTime: new Date().toISOString(),
            wakeupTime: new Date(Date.now() + sleepMs).toISOString(),
            sleepHours: sleepHours,
            hibernationCount: this.hibernationCount
        };

        // Lưu xuống MongoDB
        await System.findOneAndUpdate(
            { key: 'circuit_breaker' },
            { isHibernating: true, stats: this.hibernationStats },
            { upsert: true }
        );

        console.log(`\n🛑 [CIRCUIT BREAKER] KÍCH HOẠT NGỦ ĐÔNG!`);
        console.log(`   Thời gian ngủ: ${sleepHours} tiếng.`);
        console.log(`   Chu kỳ ngủ thứ: ${this.hibernationCount}\n`);

        this.emit('systemStatusChanged', this.getSystemStatus());
        
        this.hibernationTimer = setTimeout(() => this.wakeUp(), sleepMs);
    }

    // Hàm wakeUp phụ trợ
    async wakeUp() {
        console.log(`\n🟢 [CIRCUIT BREAKER] HỆ THỐNG ĐÃ THỨC DẬY.`);
        this.consecutiveFailures = 0; 
        this.isHibernating = false;   
        this.hibernationStats = null;
        this.hibernationTimer = null;

        await System.findOneAndUpdate({ key: 'circuit_breaker' }, { isHibernating: false, stats: null });
        
        this.emit('systemStatusChanged', this.getSystemStatus());
        this.startWorker();
    }

    async addJob(file, folderName) {
        const job = new Job({
            jobId: file.filename,
            originalName: file.originalname,
            folderName: folderName,
            filePath: file.path,
            status: 'pending'
        });
        await job.save();
        this.startWorker();
        return job;
    }

    async getJobsSummary() {
        // [CẬP NHẬT FIX LỖI] Vượt rào 32MB RAM Limit: Ép MongoDB sử dụng ổ cứng tạm (Disk) để sắp xếp dữ liệu
        return await Job.find({}, 'jobId originalName folderName status error')
            .sort({ createdAt: -1 })
            .allowDiskUse(true);
    }

    async getJobResult(jobId) {
        return await Job.findOne({ jobId });
    }

    async startWorker() {
        if (this.isProcessing || this.isHibernating) return; 
        
        try {
            const nextJob = await Job.findOne({ status: 'pending' }).sort({ createdAt: 1 });
            if (!nextJob) {
                this.isProcessing = false; 
                return;
            }

            this.isProcessing = true;
            nextJob.status = 'processing';
            await nextJob.save();
            this.emit('jobUpdated', nextJob); 

            const emitLog = (msg) => {
                console.log(`[${nextJob.originalName}] ${msg}`);
                this.emit('jobLog', { jobId: nextJob.jobId, msg });
            };

            try {
                // [CHỐT CHẶN VẬT LÝ] Kiểm tra file có tồn tại trên ổ cứng không
                if (!fs.existsSync(nextJob.filePath)) {
                    throw new Error('FILE_NOT_FOUND_ON_DISK');
                }

                emitLog(`Đang đọc file...`);
                const fileBuffer = fs.readFileSync(nextJob.filePath);
                emitLog(`Đang băm PDF...`);
                const chunkBuffers = await processPdf(fileBuffer);
                const mdResult = await processTranslation(chunkBuffers, emitLog);

                nextJob.status = 'completed';
                nextJob.result = mdResult;
                await nextJob.save();
                emitLog(`🎉 Đã dịch xong toàn bộ!`);

                // [THÀNH CÔNG] Reset toàn bộ bộ đếm Circuit Breaker về mức an toàn
                this.consecutiveFailures = 0;
                this.hibernationLevel = 1; 
                this.hibernationCount = 0; 

                if (fs.existsSync(nextJob.filePath)) {
                    fs.unlinkSync(nextJob.filePath);
                }

            } catch (error) {
                nextJob.status = 'failed';
                
                // [LỌC LỖI] Chỉ tính lỗi API mới kích hoạt ngủ đông
                if (error.message === 'FILE_NOT_FOUND_ON_DISK') {
                    nextJob.error = 'File gốc bị mất do Server khởi động lại. Vui lòng dọn dẹp và tải lại.';
                    emitLog(`❌ Lỗi: File vật lý đã bị Cloud xóa.`);
                    // TUYỆT ĐỐI KHÔNG tăng biến this.consecutiveFailures ở đây
                } else {
                    nextJob.error = error.message;
                    emitLog(`❌ Lỗi: ${error.message}`);
                    this.consecutiveFailures++; // Tăng đếm lỗi với các lỗi API thực sự
                }
                
                await nextJob.save();
            } finally {
                this.emit('jobUpdated', nextJob); 
                this.isProcessing = false;
                
                if (this.consecutiveFailures >= 10) {
                    await this.triggerHibernation(); 
                } else {
                    this.startWorker(); 
                }
            }
        } catch (dbError) {
            this.isProcessing = false;
            setTimeout(() => this.startWorker(), 5000);
        }
    }
}

export const translationQueue = new QueueManager();