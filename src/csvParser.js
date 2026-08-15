/**
 * Universal CSV Parser for Student Roster Data
 * Supports UTF-8 and TIS-620/Windows-874 thai encodings
 * Auto-detects delimiters (Comma, Semicolon, Tab, Pipe)
 * Intelligent fuzzy matching for target fields:
 * - รหัสนักเรียน (studentNo)
 * - ชื่อ (firstName)
 * - นามสกุล (lastName)
 * - แผนกวิชา / สาขา (department)
 * - ชั้น / ระดับชั้น (classLevel)
 * - ห้อง (room)
 * - เลขที่ (rollNo)
 */

// คำนำหน้าที่พบบ่อยในชื่อไทย/สากล เพื่อนำออกเมื่อดึงชื่อ-สกุล
const TITLE_PREFIXES = [
  /^นาย\s*/i,
  /^นางสาว\s*/i,
  /^น\.ส\.\s*/i,
  /^นาง\s*/i,
  /^เด็กชาย\s*/i,
  /^ด\.ช\.\s*/i,
  /^เด็กหญิง\s*/i,
  /^ด\.ญ\.\s*/i,
  /^Mr\.\s*/i,
  /^Mrs\.\s*/i,
  /^Ms\.\s*/i,
  /^Miss\s*/i,
  /^Dr\.\s*/i,
  /^Prof\.\s*/i,
];

function stripPrefix(nameStr) {
  if (!nameStr) return "";
  let result = nameStr.trim();
  for (const regex of TITLE_PREFIXES) {
    if (regex.test(result)) {
      result = result.replace(regex, "").trim();
      break;
    }
  }
  return result;
}

/**
 * แปลง Buffer หรือ String ให้เป็น CSV text แบบปลอดภัย
 */
function decodeCSVBuffer(bufferOrString) {
  if (typeof bufferOrString === "string") return bufferOrString;
  if (!Buffer.isBuffer(bufferOrString)) return String(bufferOrString || "");

  // ตรวจหา BOM (UTF-8 / UTF-16)
  if (bufferOrString[0] === 0xef && bufferOrString[1] === 0xbb && bufferOrString[2] === 0xbf) {
    return bufferOrString.toString("utf8", 3);
  }

  // พยายาม decode เป็น UTF-8 ก่อน
  try {
    const utf8Str = new TextDecoder("utf-8", { fatal: true }).decode(bufferOrString);
    return utf8Str;
  } catch {
    // ถ้า UTF-8 ล้มเหลว (มักเป็น TIS-620/Windows-874 ของภาษาไทย)
    try {
      return new TextDecoder("tis-620").decode(bufferOrString);
    } catch {
      return bufferOrString.toString("latin1");
    }
  }
}

/**
 * แยกบรรทัดและคอลัมน์ของ CSV โดยรองรับเครื่องหมายคำพูด "..." และการเว้นบรรทัดในเซลล์
 */
function parseCSVRows(csvText) {
  const cleanText = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  
  // ตรวจหาตัวคั่นที่ใช้มากที่สุดในบรรทัดแรกๆ
  const sampleLines = cleanText.split("\n").filter((l) => l.trim().length > 0).slice(0, 5);
  if (sampleLines.length === 0) return [];

  const candidates = [",", ";", "\t", "|"];
  let bestDelimiter = ",";
  let maxCounts = -1;

  for (const delim of candidates) {
    let count = 0;
    for (const line of sampleLines) {
      count += line.split(delim).length - 1;
    }
    if (count > maxCounts) {
      maxCounts = count;
      bestDelimiter = delim;
    }
  }

  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const c = cleanText[i];
    const next = cleanText[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === bestDelimiter && !inQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = "";
    } else if (c === "\n" && !inQuotes) {
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = "";
    } else {
      currentCell += c;
    }
  }

  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * กฎการจับคู่ชื่อคอลัมน์อัตโนมัติ (Fuzzy Header Matching)
 */
const FIELD_KEYWORDS = {
  studentNo: [
    /รหัส.*นักเรียน/i,
    /รหัส.*ประจำตัว/i,
    /^รหัส$/i,
    /student.*id/i,
    /std.*id/i,
    /code/i,
    /id_code/i,
    /^id$/i,
  ],
  firstName: [
    /^ชื่อ$/i,
    /ชื่อจริง/i,
    /first.*name/i,
    /fname/i,
    /given.*name/i,
    /ชื่อ.*สกุล/i, // กรณีรวมชื่อ-สกุลไว้คอลัมน์เดียว
    /ชื่อ.*นามสกุล/i,
    /^name$/i,
  ],
  lastName: [
    /นามสกุล/i,
    /^สกุล$/i,
    /last.*name/i,
    /lname/i,
    /surname/i,
    /family.*name/i,
  ],
  department: [
    /แผนก.*วิชา/i,
    /^แผนก$/i,
    /สาขา.*วิชา/i,
    /^สาขา$/i,
    /วิชาเอก/i,
    /department/i,
    /dept/i,
    /major/i,
    /program/i,
  ],
  classLevel: [
    /^ชั้น$/i,
    /ระดับชั้น/i,
    /ชั้นปี/i,
    /^ปี$/i,
    /class/i,
    /grade/i,
    /level/i,
    /year/i,
  ],
  room: [
    /^ห้อง$/i,
    /ห้องเรียน/i,
    /^sec$/i,
    /section/i,
    /room/i,
    /group/i,
  ],
  rollNo: [
    /เลขที่/i,
    /ลำดับที่/i,
    /roll.*no/i,
    /seat.*no/i,
    /^roll$/i,
    /^no\.?$/i,
    /number/i,
  ],
};

function autoDetectHeaderMapping(headers) {
  const mapping = {
    studentNo: -1,
    firstName: -1,
    lastName: -1,
    department: -1,
    classLevel: -1,
    room: -1,
    rollNo: -1,
  };

  headers.forEach((header, index) => {
    const cleanHeader = header.trim();
    if (!cleanHeader) return;

    for (const [field, regexList] of Object.entries(FIELD_KEYWORDS)) {
      if (mapping[field] !== -1) continue; // จับคู่ได้แล้ว
      for (const regex of regexList) {
        if (regex.test(cleanHeader)) {
          mapping[field] = index;
          break;
        }
      }
    }
  });

  return mapping;
}

/**
 * แยกชื่อวิเคราะห์ข้อมูลแถวเพื่อแปลงเป็นวัตถุนักเรียนมาตรฐาน
 */
function mapRowsToStudents(rows, headerMapping, headerRowIndex = 0) {
  const dataRows = rows.slice(headerRowIndex + 1);
  const students = [];

  dataRows.forEach((row, rowIndex) => {
    const getValue = (colIdx) => (colIdx >= 0 && colIdx < row.length ? row[colIdx]?.trim() || "" : "");

    let rawStudentNo = getValue(headerMapping.studentNo);
    let rawFirstName = getValue(headerMapping.firstName);
    let rawLastName = getValue(headerMapping.lastName);
    let department = getValue(headerMapping.department);
    let classLevel = getValue(headerMapping.classLevel);
    let room = getValue(headerMapping.room);
    let rollNo = getValue(headerMapping.rollNo);

    // หากไม่มีรหัสนักเรียน และไม่มีชื่อ ให้ข้ามแถวนี้ (อาจเป็นแถวว่างหรือส่วนท้าย)
    if (!rawStudentNo && !rawFirstName) return;

    // ถ้าไม่มีนามสกุลแต่คอลัมน์ชื่อมีเว้นวรรค (เช่น "นายสมชาย ใจดี" หรือ "สมชาย ใจดี")
    let firstName = stripPrefix(rawFirstName);
    let lastName = rawLastName ? stripPrefix(rawLastName) : "";

    if (!lastName && firstName.includes(" ")) {
      const parts = firstName.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }
    }

    // ทำความสะอาดรหัสนักเรียน (ลบอักขระพิเศษหากจำเป็น แต่คงศูนย์นำหน้าไว้)
    const studentNo = rawStudentNo || `STD-${rowIndex + 1}`;

    students.push({
      studentNo,
      firstName: firstName || "ไม่ระบุชื่อ",
      lastName: lastName || "-",
      department: department || null,
      classLevel: classLevel || null,
      room: room || null,
      rollNo: rollNo || null,
      rawRowIndex: headerRowIndex + 1 + rowIndex,
    });
  });

  return students;
}

/**
 * วิเคราะห์และประมวลผล CSV ทั้งหมด
 */
function parseStudentCSV(bufferOrString) {
  const text = decodeCSVBuffer(bufferOrString);
  const rows = parseCSVRows(text);

  if (rows.length === 0) {
    return { headers: [], mapping: {}, students: [], totalRows: 0 };
  }

  // หาบรรทัดที่เป็น Header (มักเป็นแถวแรกที่มีข้อมูลข้อความหลายคอลัมน์)
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i];
    if (row.length >= 2) {
      headerRowIndex = i;
      break;
    }
  }

  const headers = rows[headerRowIndex] || [];
  const mapping = autoDetectHeaderMapping(headers);
  const students = mapRowsToStudents(rows, mapping, headerRowIndex);

  return {
    headers,
    mapping,
    students,
    totalRows: rows.length - (headerRowIndex + 1),
  };
}

module.exports = {
  decodeCSVBuffer,
  parseCSVRows,
  autoDetectHeaderMapping,
  mapRowsToStudents,
  parseStudentCSV,
  stripPrefix,
};
