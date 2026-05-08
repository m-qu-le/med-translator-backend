import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
    jobId: { type: String, required: true, unique: true }, // Tương ứng filename của Multer
    originalName: { type: String, required: true },
    folderName: { type: String, default: 'Mặc định' }, // [THÊM MỚI] Nhóm các file lại thành thư mục
    filePath: { type: String, required: true },
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'completed', 'failed'], 
        default: 'pending' 
    },
    result: { type: String, default: null }, // Chứa chuỗi Markdown sau khi dịch
    error: { type: String, default: null }
}, { timestamps: true });

// ============================================================================
// [KIẾN TRÚC TỐI ƯU HÓA I/O DATABASE - INDEXING STRATEGY]
// ============================================================================

// 1. Index Đơn (Single Index): Giải quyết dứt điểm lỗi "Sort exceeded 32MB RAM" 
// trên API GET /jobs bằng cách map thẳng thứ tự giảm dần vào ổ cứng của MongoDB.
jobSchema.index({ createdAt: -1 });

// 2. Index Phức hợp (Compound Index) #1: Tối ưu cho hàm startWorker()
// Truy vấn: Job.findOne({ status: 'pending' }).sort({ createdAt: 1 })
// Tránh Full Collection Scan khi hàng đợi có hàng ngàn file.
jobSchema.index({ status: 1, createdAt: 1 });

// 3. Index Phức hợp (Compound Index) #2: Tối ưu cho cơ chế Auto-Recovery (Sweeper)
// Truy vấn: Job.updateMany({ status: 'failed', updatedAt: { $lte: thirtyMinsAgo } })
jobSchema.index({ status: 1, updatedAt: 1 });

// 4. Index Đơn: Tăng tốc độ thực thi API Xóa toàn bộ hàng đợi của một thư mục
// Truy vấn: Job.deleteMany({ folderName })
jobSchema.index({ folderName: 1 });

export default mongoose.model('Job', jobSchema);