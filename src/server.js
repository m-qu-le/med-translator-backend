import './test-keys.js';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

// 🛠️ GIẢI PHÁP ĐẶC TRỊ: Xác định đường dẫn tuyệt đối tới file .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Di chuyển ngược ra 1 cấp từ src/ để tìm file .env tại thư mục gốc
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose'; 
import translateRoute from './routes/translateRoute.js';

// [THÊM MỚI] Bổ sung đường truyền tĩnh mạch: Import QueueManager để gọi khởi tạo sau khi có DB
import { translationQueue } from './services/queueManager.js'; 

// 💉 Tiêm "ống dò" kiểm tra lại
console.log("-----------------------------------------------");
console.log("🔍 [KIỂM TRA CWD]:", process.cwd());
console.log("🔍 [KIỂM TRA BIẾN MÔI TRƯỜNG]:");
console.log("   - GEMINI_API_KEYS:", process.env.GEMINI_API_KEYS ? "✅ ĐÃ NHẬN" : "❌ TRỐNG");
console.log("   - MONGODB_URI:", process.env.MONGODB_URI ? "✅ ĐÃ NHẬN" : "❌ TRỐNG");
console.log("-----------------------------------------------");

const app = express();
const PORT = process.env.PORT || 8080; 

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// [GIAI ĐOẠN 4]: Heartbeat Endpoint siêu nhẹ chống Cloud Sleep mode
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.use('/api/translate', translateRoute);

app.use((err, req, res, next) => {
    console.error('❌ Lỗi không xác định:', err.stack);
    res.status(500).json({ error: 'Lỗi Server Nội Bộ!' });
});

// Ép Mongoose không chờ (buffering) nếu mất kết nối, fail-fast ngay lập tức
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
    .then(async () => { 
        console.log(`🟢 [DATABASE] Đã kết nối thành công tới MongoDB.`);
        
        // Quét Zombie Jobs CHỈ KHI Database thực sự thông luồng
        await translationQueue.initDB(); 
        
        // Chỉ mở Port HTTP sau khi Database và Queue đã hoàn tất setup
        app.listen(PORT, () => {
            console.log(`-----------------------------------------------`);
            console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
            console.log(`-----------------------------------------------`);
        });
    })
    .catch((error) => {
        console.error(`🔴 [DATABASE] Lỗi kết nối MongoDB:`, error.message);
        process.exit(1); 
    });