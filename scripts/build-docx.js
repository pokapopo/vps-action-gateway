"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "docs", "open-source-usage-guide.md");
const output = path.join(root, "docs", "VPS-Action-Gateway-使用与接入指南.docx");
const build = path.join(root, ".docx-build");
const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text, props = "") => `<w:r>${props}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const inlineRuns = (text) => {
  const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return run(part.slice(1, -1), '<w:rPr><w:rFonts w:ascii="Aptos Mono" w:eastAsia="Microsoft YaHei"/><w:color w:val="444444"/><w:shd w:val="clear" w:fill="F2F2F0"/><w:sz w:val="20"/></w:rPr>');
    if (part.startsWith("**") && part.endsWith("**")) return run(part.slice(2, -2), "<w:rPr><w:b/></w:rPr>");
    return run(part);
  }).join("");
};
const paragraph = (text, style = "Normal", extra = "") => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>${inlineRuns(text)}</w:p>`;
const code = (text) => `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>${run(text)}</w:p>`;
const pageBreak = () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
const crc32 = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
};
const makeZip = (files) => {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of files) {
    const nameBuffer = Buffer.from(name);
    const input = Buffer.from(contents);
    const compressed = zlib.deflateRawSync(input);
    const crc = crc32(input);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(input.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28); nameBuffer.copy(local, 30);
    locals.push(local, compressed);
    const entry = Buffer.alloc(46 + nameBuffer.length);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(input.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28); entry.writeUInt16LE(0, 30); entry.writeUInt16LE(0, 32); entry.writeUInt32LE(0, 38); entry.writeUInt32LE(offset, 42); nameBuffer.copy(entry, 46);
    central.push(entry); offset += local.length + compressed.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
};

const lines = fs.readFileSync(source, "utf8").replace(/\r/g, "").split("\n");
let inCode = false;
let body = "";
let titleSeen = false;
let coverEnded = false;
for (const line of lines) {
  if (line.startsWith("```")) { inCode = !inCode; continue; }
  if (inCode) { body += code(line || " "); continue; }
  if (!line) continue;
  if (line.startsWith("# ") && !titleSeen) {
    titleSeen = true;
    body += paragraph("OPEN-SOURCE GUIDE", "Eyebrow");
    body += paragraph(line.slice(2), "Title");
  }
  else if (line.startsWith("## ")) {
    if (!coverEnded) { body += pageBreak(); coverEnded = true; }
    body += paragraph(line.slice(3), "Heading1");
  }
  else if (line.startsWith("### ")) body += paragraph(line.slice(4), "Heading2");
  else if (line.startsWith("- [ ] ")) body += paragraph(`☐ ${line.slice(6)}`, "ListParagraph");
  else if (line.startsWith("- ")) body += paragraph(`• ${line.slice(2)}`, "ListParagraph");
  else if (/^\d+\. /.test(line)) body += paragraph(line, "ListParagraph");
  else if (line.startsWith("> ")) body += paragraph(line.slice(2), "Quote");
  else body += paragraph(line, coverEnded ? "Normal" : "CoverMeta");
}

const files = [
  ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
  ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
  ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ["word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:color w:val="262626"/><w:sz w:val="21"/><w:lang w:val="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="150" w:line="340" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Eyebrow"><w:name w:val="Eyebrow"/><w:pPr><w:spacing w:before="2400" w:after="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos"/><w:b/><w:color w:val="8A8A84"/><w:sz w:val="18"/><w:spacing w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="300"/><w:pBdr><w:bottom w:val="single" w:sz="18" w:space="18" w:color="202020"/></w:pBdr></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="171717"/><w:sz w:val="54"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="CoverMeta"><w:name w:val="Cover Meta"/><w:pPr><w:spacing w:before="240" w:after="40"/></w:pPr><w:rPr><w:color w:val="555550"/><w:sz w:val="21"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:pPr><w:spacing w:before="220" w:after="180"/></w:pPr><w:rPr><w:color w:val="555550"/><w:sz w:val="25"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:pPr><w:spacing w:before="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Mono"/><w:color w:val="999994"/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:keepNext/><w:spacing w:before="500" w:after="220"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="171717"/><w:sz w:val="31"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="150"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="363633"/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:spacing w:after="0" w:line="275" w:lineRule="auto"/><w:ind w:left="240" w:right="240"/><w:shd w:val="clear" w:fill="F5F5F3"/><w:pBdr><w:left w:val="single" w:sz="14" w:space="12" w:color="C7C7C2"/></w:pBdr></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Mono" w:hAnsi="Aptos Mono" w:eastAsia="Microsoft YaHei"/><w:color w:val="333333"/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:spacing w:after="80" w:line="320" w:lineRule="auto"/><w:ind w:left="400" w:hanging="240"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:spacing w:before="180" w:after="220"/><w:ind w:left="360" w:right="240"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="14" w:color="A8A8A2"/></w:pBdr></w:pPr><w:rPr><w:color w:val="555550"/><w:i/></w:rPr></w:style>
  </w:styles>`],
  ["word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:background w:color="FFFFFF"/><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1220" w:right="1320" w:bottom="1220" w:left="1320"/></w:sectPr></w:body></w:document>`],
];
fs.rmSync(output, { force: true });
fs.writeFileSync(output, makeZip(files));
fs.rmSync(build, { recursive: true, force: true });
console.log(output);
