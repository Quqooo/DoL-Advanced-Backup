/**
 * ZIP 结构尺寸与字段上限：读、写、分卷三处共用一份。
 *
 * 放在独立模块：读端不该依赖写端，格式若扩展也只改这里。
 */

/** 本地文件头、中央目录项、中央目录结束记录（EOCD）的固定部分长度 */
export const LOCAL_SIZE = 30;
export const CENTRAL_SIZE = 46;
export const EOCD_SIZE = 22;

/** 长度字段是 uint32、条目数是 uint16，这里没有实现 zip64 */
export const MAX_UINT32 = 0xffffffff;
export const MAX_ENTRIES = 0xffff;
