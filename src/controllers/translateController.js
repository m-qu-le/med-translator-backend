import { translationQueue } from '../services/queueManager.js';
import Job from '../models/jobModel.js';

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

    translationQueue.on('jobUpdated', onJobUpdated);
    translationQueue.on('jobLog', onJobLog);

    req.on('close', () => {
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