import { parentPort, workerData } from 'worker_threads';
import { splitPdfToBuffers } from '../utils/pdfSplitter.js';

async function executeSplit() {
    try {
        // 🛠️ FIX: Ép kiểu ngược lại thành Node.js Buffer chuẩn ngay khi nhận từ Main Thread
        // Điều này đảm bảo thư viện băm PDF (pdf-lib) đọc đúng format
        const validFileBuffer = Buffer.from(workerData.fileBuffer);
        
        const { chunkBuffers, totalPages } = await splitPdfToBuffers(validFileBuffer, 3);
        
        parentPort.postMessage({ success: true, chunkBuffers, totalPages });
    } catch (error) {
        parentPort.postMessage({ success: false, error: error.message });
    }
}

executeSplit();