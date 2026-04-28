import { EventEmitter } from 'events';
import fs from 'fs';
import { processPdf } from './pdfService.js';
import { processTranslation } from './geminiService.js';
import Job from '../models/jobModel.js'; 

export class QueueManager extends EventEmitter {
    constructor() {
        super();
        this.isProcessing = false;
        
        // [CƠ CHẾ CIRCUIT BREAKER] Quản lý trạng thái Ngủ đông
        this.consecutiveFailures = 0;   // Bộ đếm lỗi nghiêm trọng liên tiếp
        this.isHibernating = false;     // Cờ khóa luồng hệ thống
        this.hibernationLevel = 1;      // Mốc 1: 1 tiếng, Mốc >=2: 2 tiếng
    }

    async initDB() {
        try {
            // 1. Phục hồi Zombie Jobs (Bị ngắt do server restart)
            const result = await Job.updateMany({ status: 'processing' }, { $set: { status: 'pending' } });
            if (result.modifiedCount > 0) {
                console.log(`♻️ [QUEUE] Đã khôi phục ${result.modifiedCount} tác vụ (Zombie Jobs) về trạng thái Pending.`);
            }
            
            // 2. Kích hoạt radar quét lỗi định kỳ (30 phút thử lại)
            this.startFailedJobsSweeper();
            
            // 3. Khởi động vòng lặp Worker
            this.startWorker(); 
        } catch (error) {
            console.error('❌ [QUEUE] Lỗi khi khôi phục Zombie Jobs:', error);
        }
    }

    // [TÍNH NĂNG 1] LUỒNG QUÉT VÀ PHỤC HỒI LỖI TẠM THỜI
    startFailedJobsSweeper() {
        // Chạy ngầm kiểm tra mỗi 15 phút (900,000 ms)
        setInterval(async () => {
            if (this.isHibernating) return; // Nếu đang ngủ đông thì không quét
            
            try {
                // Lấy mốc thời gian cách đây 30 phút
                const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
                
                // Tìm các file 'failed' đã nằm im hơn 30 phút và đẩy về 'pending'
                const result = await Job.updateMany(
                    { status: 'failed', updatedAt: { $lte: thirtyMinsAgo } },
                    { $set: { status: 'pending', error: '🔄 Tự động thử lại sau 30 phút...' } }
                );
                
                if (result.modifiedCount > 0) {
                    console.log(`\n♻️ [AUTO-RECOVERY] Đã tìm thấy và đưa ${result.modifiedCount} files bị lỗi tạm thời quay lại hàng đợi.`);
                    this.startWorker(); // Kích hoạt lại worker nếu đang rảnh
                }
            } catch (error) {
                console.error('❌ [AUTO-RECOVERY] Lỗi khi truy vấn Database:', error.message);
            }
        }, 15 * 60 * 1000);
    }

    // [TÍNH NĂNG 2] CƠ CHẾ NGỦ ĐÔNG (CIRCUIT BREAKER)
    triggerHibernation() {
        this.isHibernating = true; // Khóa Worker
        
        const sleepHours = this.hibernationLevel === 1 ? 1 : 2;
        const sleepMs = sleepHours * 60 * 60 * 1000;
        const wakeupTime = new Date(Date.now() + sleepMs).toLocaleTimeString('vi-VN');
        
        console.log(`\n🛑 [CIRCUIT BREAKER] KÍCH HOẠT NGỦ ĐÔNG TOÀN HỆ THỐNG!`);
        console.log(`   Nguyên nhân: Vượt quá 10 lỗi nghiêm trọng liên tiếp (Khả năng cạn kiệt API Quota).`);
        console.log(`   Thời gian ngủ: ${sleepHours} tiếng.`);
        console.log(`   Dự kiến đánh thức lúc: ${wakeupTime}\n`);

        // Tăng level ngủ đông cho lần chạm đáy tiếp theo
        if (this.hibernationLevel === 1) {
            this.hibernationLevel = 2;
        }

        // Hẹn giờ tự động thức giấc
        setTimeout(() => {
            console.log(`\n🟢 [CIRCUIT BREAKER] HỆ THỐNG ĐÃ THỨC DẬY SAU ${sleepHours} TIẾNG NGỦ ĐÔNG.`);
            this.consecutiveFailures = 0; // Reset lại bộ đếm lỗi
            this.isHibernating = false;   // Mở khóa Worker
            this.startWorker();           // Bơm máu lại cho hệ thống
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
        const jobs = await Job.find({}, 'jobId originalName folderName status error').sort({ createdAt: -1 });
        return jobs;
    }

    async getJobResult(jobId) {
        return await Job.findOne({ jobId });
    }

    async startWorker() {
        // [QUAN TRỌNG] Chặn đứng luồng nếu đang xử lý hoặc đang bị khóa bởi Circuit Breaker
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
                emitLog(`Đang đọc file từ ổ cứng lên RAM...`);
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

                if (fs.existsSync(nextJob.filePath)) {
                    fs.unlinkSync(nextJob.filePath);
                }

            } catch (error) {
                nextJob.status = 'failed';
                nextJob.error = error.message;
                await nextJob.save();
                emitLog(`❌ Lỗi quá trình dịch: ${error.message}`);
                
                // [LỖI NGHIÊM TRỌNG] Tăng bộ đếm lỗi
                this.consecutiveFailures++;
                console.log(`⚠️ [CẢNH BÁO RATE LIMIT] Số file lỗi liên tiếp: ${this.consecutiveFailures}/10`);

            } finally {
                this.emit('jobUpdated', nextJob); 
                this.isProcessing = false;
                
                // [ĐIỀU HƯỚNG WORKER] 
                if (this.consecutiveFailures >= 10) {
                    this.triggerHibernation(); // Vượt quá 10 lỗi -> Ngủ đông
                } else {
                    this.startWorker(); // Ngược lại -> Đệ quy gọi Job tiếp theo
                }
            }
        } catch (dbError) {
            console.error('❌ [QUEUE] Lỗi Database trong quá trình quét Hàng đợi:', dbError);
            this.isProcessing = false;
            setTimeout(() => this.startWorker(), 5000);
        }
    }
}

export const translationQueue = new QueueManager();