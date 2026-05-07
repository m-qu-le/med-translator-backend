import { translationQueue } from '../services/queueManager.js';
import Job from '../models/jobModel.js';
import fs from 'fs'; // [THÊM DÒNG NÀY] Import fs để dọn dẹp file PDF vật lý trên ổ cứng

// API 1: Bọc try-catch, dùng Promise.all để ghi đa file vào DB
export const uploadFiles = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Không tìm thấy file nào được tải lên.' });
        }

        // [THÊM MỚI] Trích xuất tên thư mục từ request, nếu không có thì để "Mặc định"
        const folderName = req.body.folderName || 'Mặc định';

        const jobs = await Promise.all(
            // [SỬA ĐỔI] Truyền thêm folderName vào hàng đợi
            req.files.map(file => translationQueue.addJob(file, folderName))
        );
        
        res.status(200).json({ 
            message: 'Đã đưa vào hàng chờ xử lý trên Cloud/Database', 
            jobs: jobs.map(j => ({ 
                jobId: j.jobId, 
                originalName: j.originalName, 
                status: j.status,
                folderName: j.folderName 
            })) 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// API 2: Đổi thành Async
export const getJobsSummary = async (req, res) => {
    try {
        const jobs = await translationQueue.getJobsSummary();
        res.status(200).json(jobs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// API 3: Trích xuất qua ID từ Database
export const getJobResult = async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await translationQueue.getJobResult(jobId);
        
        if (!job) return res.status(404).json({ error: 'Không tìm thấy công việc này.' });
        if (job.status !== 'completed') return res.status(400).json({ error: 'Tài liệu chưa dịch xong.' });
        
        res.status(200).json({ result: job.result });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};

// API 4: Luồng SSE (Giữ kết nối mở cho Cloud)
export const streamLogs = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); 

    res.write(`data: ${JSON.stringify({ type: 'connected', msg: 'SSE Stream Ready' })}\n\n`);

    // [THÊM MỚI] Cơ chế Heartbeat ép Proxy/Load Balancer không ngắt mạng
    const heartbeat = setInterval(() => {
        // Gửi ký tự comment rỗng theo chuẩn SSE, phía Frontend sẽ tự động bỏ qua
        res.write(`: keep-alive-ping\n\n`);
    }, 15000); 

    const onJobUpdated = (job) => {
        const payload = { type: 'status', jobId: job.jobId, status: job.status, error: job.error };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const onJobLog = ({ jobId, msg }) => {
        const payload = { type: 'log', jobId, msg };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // [THÊM MỚI] Lắng nghe sự thay đổi trạng thái Ngủ đông
    const onSystemStatusChanged = (statusPayload) => {
        const payload = { type: 'systemStatus', data: statusPayload };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    translationQueue.on('systemStatusChanged', onSystemStatusChanged);
    translationQueue.on('jobUpdated', onJobUpdated);
    translationQueue.on('jobLog', onJobLog);

    req.on('close', () => {
        translationQueue.off('systemStatusChanged', onSystemStatusChanged); // Bổ sung off event
        translationQueue.off('jobUpdated', onJobUpdated);
        translationQueue.off('jobLog', onJobLog);
        clearInterval(heartbeat); // Ngăn rò rỉ bộ nhớ (Memory Leak)
        res.end();
    });
};

// API 5: Xóa tiến trình khỏi Database
export const deleteJob = async (req, res) => {
    try {
        const { jobId } = req.params;
        const deletedJob = await Job.findOneAndDelete({ jobId });
        
        if (!deletedJob) {
            return res.status(404).json({ error: 'Không tìm thấy tiến trình để xóa.' });
        }
        
        res.status(200).json({ message: 'Đã xóa tiến trình thành công.' });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};

// API 6: Xóa hàng loạt tiến trình (Tối ưu Database I/O bằng deleteMany)
export const bulkDeleteJobs = async (req, res) => {
    try {
        const { jobIds } = req.body; // Nhận mảng các jobId từ Frontend
        
        if (!jobIds || !Array.isArray(jobIds)) {
            return res.status(400).json({ error: 'Danh sách ID không hợp lệ.' });
        }

        // Xóa một lần toàn bộ các document có jobId nằm trong mảng
        const result = await Job.deleteMany({ jobId: { $in: jobIds } });
        
        res.status(200).json({ 
            message: `Đã dọn dẹp thành công ${result.deletedCount} tiến trình.`, 
            deletedCount: result.deletedCount 
        });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};

// API 7: Lấy trạng thái hệ thống (Kiểm tra xem có đang ngủ đông không)
export const getSystemStatus = (req, res) => {
    try {
        const status = translationQueue.getSystemStatus();
        res.status(200).json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// [THÊM MỚI] API 8: Ép hệ thống thức dậy thủ công
export const forceWakeUpSystem = async (req, res) => {
    try {
        // Cần await vì forceWakeUp trong queueManager.js là hàm async
        const isWokenUp = await translationQueue.forceWakeUp();
        
        if (isWokenUp) {
            res.status(200).json({ message: 'Đã ép hệ thống thức dậy thành công!' });
        } else {
            res.status(400).json({ message: 'Hệ thống hiện không ở trạng thái ngủ đông.' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// [THÊM MỚI] API 9: Xóa toàn bộ hàng đợi của một thư mục (Bao gồm DB và File vật lý)
export const deleteFolderQueue = async (req, res) => {
    try {
        const { folderName } = req.params;
        
        // 1. Tìm tất cả các tiến trình thuộc thư mục này để lấy đường dẫn file vật lý
        const jobsToDelete = await Job.find({ folderName });
        
        // 2. Dọn dẹp ổ cứng: Quét và xóa toàn bộ file PDF còn tồn đọng
        jobsToDelete.forEach(job => {
            if (job.filePath && fs.existsSync(job.filePath)) {
                try { 
                    fs.unlinkSync(job.filePath); 
                } catch (e) { 
                    console.error(`[Garbage Collection] Lỗi xóa file vật lý ${job.filePath}:`, e); 
                }
            }
        });

        // 3. Xóa triệt để các Document trong MongoDB
        const result = await Job.deleteMany({ folderName });
        
        res.status(200).json({ 
            message: `Đã xóa hoàn toàn thư mục [${folderName}] với ${result.deletedCount} tiến trình.`, 
            deletedCount: result.deletedCount 
        });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};