import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';

// Xác định đường dẫn tuyệt đối đến file pdfWorker.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const processPdf = (fileBuffer) => {
    // Đóng gói tác vụ thành một Promise để QueueManager vẫn dùng được await như cũ
    return new Promise((resolve, reject) => {
        console.log("⚙️ [MAIN THREAD] Đang bàn giao tác vụ băm PDF sang Worker Thread...");
        
        const workerPath = path.resolve(__dirname, '../workers/pdfWorker.js');
        
        // Khởi tạo Worker, truyền fileBuffer sang
        const worker = new Worker(workerPath, {
            workerData: { fileBuffer }
        });

        // Lắng nghe tín hiệu từ Worker trả về
        worker.on('message', (message) => {
            if (message.success) {
                console.log(`✅ [WORKER] Cắt thành công! Sách có ${message.totalPages} trang, chia thành ${message.chunkBuffers.length} chunk nhỏ.`);
                resolve(message.chunkBuffers); // Trả mảng chunks về cho queueManager
            } else {
                reject(new Error(message.error));
            }
        });

        // Xử lý các trường hợp ngoại khoa (lỗi vỡ luồng)
        worker.on('error', (err) => {
            console.error("❌ [WORKER ERROR]:", err);
            reject(err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker Thread bị ngắt đột ngột với mã lỗi ${code}`));
            }
        });
    });
};