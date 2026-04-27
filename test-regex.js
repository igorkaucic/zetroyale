const html = 'Kolodvor: \\\\u003C/I>\\\\u003Cstrong>HRVATSKI+LESKOVAC\\\\u003Cbr> \\\\u003C/TD>\\\\u003CTR>\\\\r\\\\n\\\\u003CTD BGCOLOR=#bbddff>\\\\u003CI>Dolazak  \\\\u003C/I>\\\\u003Ccr>\\\\r\\\\n23.04.26. u 14:45 sati\\\\u003C/TD>\\\\u003CTR>\\\\r\\\\n\\\\u003CTD>\\\\u003CFONT FACE=Arial,Helvetica COLOR=#FF000A>\\\\r\\\\n\\\\u003CBLINK>Kasni   31 min. ';
const kolodvorMatch = html.match(/Kolodvor:(?:.*?)strong[>E](.*?)\\\\u003C/i);
const delayMatch = html.match(/Kasni\s+(\d+)\s+min/i);
const timeMatch = html.match(/u\s+(\d{1,2}:\d{2})\s+sati/i);
console.log(kolodvorMatch[1].replace(/\+/g, ' ').trim());
console.log(delayMatch[1]);
console.log(timeMatch[1]);
