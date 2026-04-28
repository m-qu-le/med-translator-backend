import { PDFDocument } from 'pdf-lib';

/**
 * Hàm cắt PDF từ Buffer gốc thành mảng các Buffer nhỏ (mỗi Buffer là 1 chunk)
 */
export async function splitPdfToBuffers(pdfBuffer, pagesPerChunk = 10) {
    // 1. Tải file PDF từ bộ nhớ RAM
    const originalPdf = await PDFDocument.load(pdfBuffer);
    const totalPages = originalPdf.getPageCount();
    const chunkBuffers = [];

    // 2. Vòng lặp để cắt từng khúc
    for (let i = 0; i < totalPages; i += pagesPerChunk) {
        // Tạo một file PDF trống mới
        const chunkPdf = await PDFDocument.create();
        
        // Tính toán trang bắt đầu và kết thúc (ngừa trường hợp chunk cuối bị lẻ)
        const endIndex = Math.min(i + pagesPerChunk, totalPages);
        const pageIndices = Array.from({ length: endIndex - i }, (_, k) => i + k);

        // Copy các trang từ file gốc sang file trống vừa tạo
        const copiedPages = await chunkPdf.copyPages(originalPdf, pageIndices);
        copiedPages.forEach((page) => chunkPdf.addPage(page));

        // Lưu chunk lại dưới dạng mảng byte (Uint8Array) rồi chuyển sang Buffer
        const chunkBytes = await chunkPdf.save();
        chunkBuffers.push(Buffer.from(chunkBytes));
    }

    return { chunkBuffers, totalPages };
}