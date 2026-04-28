import { EventEmitter } from 'events';
import fs from 'fs';
import { processPdf } from './pdfService.js';
import { processTranslation } from './geminiService.js';
import Job from '../models/jobModel.js'; 

export class QueueManager extends EventEmitter {
    constructor() {
        super();
        this.isProcessing = false;
        
        // [CƠ CHẾ CIRCUIT BREAKER]
        this.consecutiveFailures = 0;   
        this.isHibernating = false;     
        this.hibernationLevel = 1;      
        
        // [THÊM MỚI] Dữ liệu giám sát ngủ đông để gửi cho Frontend
        this.hibernationCount = 0; // Đếm số lần đã đi ngủ
        this.hibernationStats = null; // Lưu chi tiết thời gian
    }

    async initDB() {
        try {
            const result = await Job.updateMany({ status: 'processing' }, { $set: { status: 'pending' } });
            if (result.modifiedCount > 0) {
                console.log(`♻️ [QUEUE] Đã khôi phục ${result.modifiedCount} tác vụ (Zombie Jobs) về trạng thái Pending.`);
            }
            this.startFailedJobsSweeper();
            this.startWorker(); 
        } catch (error) {
            console.error('❌ [QUEUE] Lỗi khi khôi phục Zombie Jobs:', error);
        }
    }

    // [THÊM MỚI] API Nội bộ cho Controller lấy trạng thái hiện tại
    getSystemStatus() {
        return {
            isHibernating: this.isHibernating,
            stats: this.hibernationStats
        };
    }

    startFailedJobsSweeper() {
        setInterval(async () => {
            if (this.isHibernating) return; 
            try {
                const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
                const result = await Job.updateMany(
                    { status: 'failed', updatedAt: { $lte: thirtyMinsAgo } },
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

    triggerHibernation() {
        this.isHibernating = true; 
        this.hibernationCount++; // Tăng số chu kỳ đã ngủ
        
        const sleepHours = this.hibernationLevel === 1 ? 1 : 2;
        const sleepMs = sleepHours * 60 * 60 * 1000;
        
        // Cập nhật thống kê
        this.hibernationStats = {
            startTime: new Date().toISOString(),
            wakeupTime: new Date(Date.now() + sleepMs).toLocaleTimeString('vi-VN'),
            sleepHours: sleepHours,
            hibernationCount: this.hibernationCount
        };

        // Bắn tín hiệu sang Controller để đẩy xuống SSE Frontend
        this.emit('systemStatusChanged', this.getSystemStatus());
        
        console.log(`\n🛑 [CIRCUIT BREAKER] KÍCH HOẠT NGỦ ĐÔNG!`);
        console.log(`   Thời gian ngủ: ${sleepHours} tiếng. Thức dậy lúc: ${this.hibernationStats.wakeupTime}`);
        console.log(`   Chu kỳ ngủ thứ: ${this.hibernationCount}\n`);

        if (this.hibernationLevel === 1) {
            this.hibernationLevel = 2;
        }

        setTimeout(() => {
            console.log(`\n🟢 [CIRCUIT BREAKER] HỆ THỐNG ĐÃ THỨC DẬY.`);
            this.consecutiveFailures = 0; 
            this.isHibernating = false;   
            this.hibernationStats = null;
            
            // Báo cho Frontend biết đã thức
            this.emit('systemStatusChanged', this.getSystemStatus());
            this.startWorker();           
        }, sleepMs);
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
        return await Job.find({}, 'jobId originalName folderName status error').sort({ createdAt: -1 });
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
                this.hibernationCount = 0; // Đã dịch thành công thì reset bộ đếm chu kỳ ngủ

                if (fs.existsSync(nextJob.filePath)) {
                    fs.unlinkSync(nextJob.filePath);
                }

            } catch (error) {
                nextJob.status = 'failed';
                nextJob.error = error.message;
                await nextJob.save();
                emitLog(`❌ Lỗi: ${error.message}`);
                
                this.consecutiveFailures++;
            } finally {
                this.emit('jobUpdated', nextJob); 
                this.isProcessing = false;
                
                if (this.consecutiveFailures >= 10) {
                    this.triggerHibernation(); 
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