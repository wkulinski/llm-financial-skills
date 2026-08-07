import fs from "node:fs";
import path from "node:path";

/**
 * Minimal dependency-free XLSX writer.  It emits an Office Open XML package
 * with inline strings and stored ZIP members, which keeps export deterministic
 * and avoids adding a runtime dependency to the standalone skill.
 */
export function writeXlsx(filePath, sheets) {
    if (!Array.isArray(sheets) || sheets.length === 0) throw new TypeError("XLSX requires at least one sheet");
    const buffer = buildXlsxBuffer(sheets);
    fs.mkdirSync(path.dirname(path.resolve(filePath)), {recursive: true});
    fs.writeFileSync(filePath, buffer, {mode: 0o600});
    return {bytes: buffer.length};
}

export function buildXlsxBuffer(sheets) {
    const entries = new Map();
    const safeSheets = sheets.map((sheet, index) => ({
        name: safeSheetName(sheet?.name ?? `Sheet${index + 1}`, index),
        rows: Array.isArray(sheet?.rows) ? sheet.rows : []
    }));
    entries.set("[Content_Types].xml", xmlBuffer(contentTypes(safeSheets.length)));
    entries.set("_rels/.rels", xmlBuffer(rootRelationships()));
    entries.set("docProps/core.xml", xmlBuffer(coreProperties()));
    entries.set("docProps/app.xml", xmlBuffer(appProperties(safeSheets)));
    entries.set("xl/workbook.xml", xmlBuffer(workbook(safeSheets)));
    entries.set("xl/_rels/workbook.xml.rels", xmlBuffer(workbookRelationships(safeSheets.length)));
    entries.set("xl/styles.xml", xmlBuffer(styles()));
    safeSheets.forEach((sheet, index) => {
        entries.set(`xl/worksheets/sheet${index + 1}.xml`, xmlBuffer(worksheet(sheet.rows)));
    });
    return zipStore(entries);
}

function contentTypes(sheetCount) {
    const overrides = Array.from({length: sheetCount}, (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides}</Types>`;
}

function rootRelationships() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function coreProperties() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>mortgage-refinancing-scan</dc:creator><dc:title>Mortgage refinancing scan</dc:title></cp:coreProperties>`;
}

function appProperties(sheets) {
    const names = sheets.map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>mortgage-refinancing-scan</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${names}</vt:vector></TitlesOfParts></Properties>`;
}

function workbook(sheets) {
    const rows = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><fileVersion appName="xl"/><workbookPr/><bookViews><workbookView workbookViewId="0"/></bookViews><sheets>${rows}</sheets></workbook>`;
}

function workbookRelationships(sheetCount) {
    const sheets = Array.from({length: sheetCount}, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function styles() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function worksheet(rows) {
    const normalizedRows = rows.map((row) => Array.isArray(row) ? row : [row]);
    const maxColumns = Math.max(1, ...normalizedRows.map((row) => row.length));
    const columns = Array.from({length: maxColumns}, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === 0 ? 9 : 22}" customWidth="1"/>`).join("");
    const body = normalizedRows.map((row, rowIndex) => {
        const cells = row.map((value, columnIndex) => cell(value, rowIndex + 1, columnIndex + 1, rowIndex === 0)).join("");
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");
    const end = `${columnName(maxColumns)}${Math.max(1, normalizedRows.length)}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${body}</sheetData><autoFilter ref="A1:${end}"/></worksheet>`;
}

function cell(value, row, column, header) {
    const reference = `${columnName(column)}${row}`;
    const style = header ? ` s="1"` : "";
    if (value === null || value === undefined || value === "") return `<c r="${reference}"${style}/>`;
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"${style} t="n"><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${reference}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
    return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function columnName(number) {
    let value = number;
    let result = "";
    while (value > 0) {
        const remainder = (value - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        value = Math.floor((value - 1) / 26);
    }
    return result || "A";
}

function safeSheetName(value, index) {
    const cleaned = String(value).replace(/[\\/?*\[\]:]/gu, " ").trim().slice(0, 31);
    return cleaned || `Sheet${index + 1}`;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;")
        .replace(/"/gu, "&quot;")
        .replace(/'/gu, "&apos;")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "");
}

function xmlBuffer(value) {
    return Buffer.from(value, "utf8");
}

function zipStore(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const nameBuffer = Buffer.from(name, "utf8");
        const crc = crc32(data);
        const local = Buffer.alloc(30 + nameBuffer.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuffer.copy(local, 30);
        localParts.push(local, data);

        const central = Buffer.alloc(46 + nameBuffer.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        nameBuffer.copy(central, 46);
        centralParts.push(central);
        offset += local.length + data.length;
    }
    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.size, 8);
    end.writeUInt16LE(entries.size, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, centralDirectory, end]);
}

const CRC_TABLE = buildCrcTable();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
    return Array.from({length: 256}, (_, index) => {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        return value >>> 0;
    });
}
