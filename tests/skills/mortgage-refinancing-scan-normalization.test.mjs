import path from "node:path";

import {describe, expect, it} from "vitest";

import {normalizeText} from "../../.agents/skills/mortgage-refinancing-scan/lib/normalization.mjs";
import {extractTextDetails} from "../../.agents/skills/mortgage-refinancing-scan/lib/research-runtime.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

describe("mortgage-refinancing-scan text extraction", () => {
    it("extracts PDF text without decoding PDF bytes as UTF-8", async () => {
        const extracted = await extractTextDetails(makePdf("Kredyt mieszkaniowy"), "application/pdf");
        expect(extracted).toMatchObject({encoding: "pdf-text", extractor: "pdf-parse"});
        expect(extracted.text).toContain("Kredyt mieszkaniowy");
    });

    it("uses the declared Windows-1250 charset for HTML", async () => {
        const html = Buffer.from([
            ...Buffer.from("<p>Sp", "ascii"),
            0xB3,
            ...Buffer.from("ata kredytu</p>", "ascii")
        ]);
        const extracted = await extractTextDetails(html, "text/html; charset=windows-1250");
        expect(extracted.encoding).toBe("windows-1250");
        expect(extracted.text).toBe("Spłata kredytu");
    });

    it("converts Morfeusz code-point offsets to JavaScript UTF-16 offsets", async () => {
        const text = "Oferta 📞 kredyt mieszkaniowy";
        const normalized = await normalizeText(text, {
            engine: "morfeusz2",
            pythonCommand: path.join(ROOT, ".venv/bin/python")
        });
        const emoji = normalized.tokens.find((token) => token.surface === "📞");
        expect(emoji).toBeDefined();
        expect(text.slice(emoji.start, emoji.end)).toBe("📞");
    });
});

function makePdf(text) {
    const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
        `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
    ];
    let body = "%PDF-1.4\n";
    const offsets = [0];
    for (const object of objects) {
        offsets.push(Buffer.byteLength(body));
        body += object;
    }
    const xrefOffset = Buffer.byteLength(body);
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(body, "binary");
}
