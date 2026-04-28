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

export default mongoose.model('Job', jobSchema);