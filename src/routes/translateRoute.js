import express from 'express';
import upload from '../middlewares/upload.js';
import { 
    uploadFiles, 
    getJobsSummary, 
    getJobResult, 
    streamLogs,
    deleteJob,
    bulkDeleteJobs,
    getSystemStatus // [THÊM MỚI]
} from '../controllers/translateController.js'; 

const router = express.Router();

// 1. API Upload nhiều file. 
// Đã nâng cấp giới hạn: Cho phép upload tối đa 100 file cùng lúc để tối ưu Workflow.
router.post('/', upload.array('files', 100), uploadFiles);

// 2. Các API lấy trạng thái và kết quả
router.get('/jobs', getJobsSummary);
router.get('/status', getSystemStatus); // [THÊM MỚI] Route lấy trạng thái hệ thống
router.get('/jobs/:jobId/result', getJobResult);

// 3. API Stream Server-Sent Events (SSE)
router.get('/stream', streamLogs);

// [THÊM MỚI] 4. API Xóa tiến trình hàng loạt 
// Định tuyến POST /bulk-delete (Nhận mảng jobIds qua req.body)
router.post('/bulk-delete', bulkDeleteJobs);

// 5. API Xóa tiến trình đơn lẻ
// Định tuyến DELETE /jobs/:jobId
router.delete('/jobs/:jobId', deleteJob);

export default router;