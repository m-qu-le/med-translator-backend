import { EventEmitter } from 'events';
import fs from 'fs';
import { processPdf } from './pdfService.js';
import { processTranslation } from './geminiService.js';
import Job from '../models/jobModel.js'; // [THÊM MỚI] Import Mongoose Schema

export class QueueManager extends EventEmitter {
    constructor() {
        super();
        this.isProcessing = false;
        // [ĐÃ CAN THIỆP] Xóa gọi hàm this.initDB() tại đây để tránh lỗi Mongoose Buffering Timeout
    }

    // [THÊM MỚI] Dọn dẹp Zombie Jobs khi Server Restart
    async initDB() {
        try {
            const result = await Job.updateMany({ status: 'processing' }, { $set: { status: 'pending' } });
            if (result.modifiedCount > 0) {
                console.log(`♻️ [QUEUE] Đã khôi phục ${result.modifiedCount} tác vụ (Zombie Jobs) về trạng thái Pending.`);
            }
            this.startWorker(); 
        } catch (error) {
            console.error('❌ [QUEUE] Lỗi khi khôi phục Zombie Jobs:', error);
        }
    }

    // Chuyển thành Async Function
    async addJob(file) {
        // Lưu thẳng vào MongoDB
        const job = new Job({
            jobId: file.filename,
            originalName: file.originalname,
            filePath: file.path,
            status: 'pending'
        });
        await job.save();
        
        this.startWorker();
        return job;
    }

    async getJobsSummary() {
        // Sắp xếp các job mới nhất lên đầu, giới hạn lấy các trường nhẹ
        const jobs = await Job.find({}, 'jobId originalName status error').sort({ createdAt: -1 });
        return jobs;
    }

    // [THÊM MỚI] Hàm chuyên biệt hỗ trợ Controller lấy kết quả
    async getJobResult(jobId) {
        return await Job.findOne({ jobId });
    }

    async startWorker() {
        if (this.isProcessing) return; 
        
        try {
            // Lấy Job chờ cũ nhất (FIFO - First In First Out)
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

                if (fs.existsSync(nextJob.filePath)) {
                    fs.unlinkSync(nextJob.filePath);
                }

            } catch (error) {
                nextJob.status = 'failed';
                nextJob.error = error.message;
                await nextJob.save();
                emitLog(`❌ Lỗi quá trình dịch: ${error.message}`);
            } finally {
                this.emit('jobUpdated', nextJob); 
                this.isProcessing = false;
                this.startWorker(); // Đệ quy gọi Job tiếp theo
            }
        } catch (dbError) {
            console.error('❌ [QUEUE] Lỗi Database trong quá trình quét Hàng đợi:', dbError);
            this.isProcessing = false;
            // Cơ chế Retry tự động sau 5s nếu Database mất kết nối ngắt quãng
            setTimeout(() => this.startWorker(), 5000);
        }
    }
}

export const translationQueue = new QueueManager();