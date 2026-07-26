// Сборка минимального, но валидного FB2.
//
// Нужен настоящий файл, а не заглушка: его будет распаковывать и разбирать C++-сервер
// (обложка, восстановление картинок, конвертеры), и читалка в браузере.

export interface Fb2Book {
  title: string;
  authors: Array<{ firstName: string; middleName: string; lastName: string }>;
  genres: string[];
  lang: string;
  year: number | null;
  annotation: string | null;
  series: { title: string; seqNumber: number | null } | null;
  keywords: string[];
  paragraphs: string[];
  cover: { fileName: string; contentType: string; base64: string } | null;
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildFb2(book: Fb2Book): string {
  const authors = book.authors
    .map(
      (author) => `      <author>
        <first-name>${escapeXml(author.firstName)}</first-name>
        <middle-name>${escapeXml(author.middleName)}</middle-name>
        <last-name>${escapeXml(author.lastName)}</last-name>
      </author>`,
    )
    .join('\n');

  const genres = book.genres.map((code) => `      <genre>${escapeXml(code)}</genre>`).join('\n');

  const annotation = book.annotation
    ? `      <annotation><p>${escapeXml(book.annotation)}</p></annotation>\n`
    : '';

  const keywords = book.keywords.length
    ? `      <keywords>${escapeXml(book.keywords.join(', '))}</keywords>\n`
    : '';

  const sequence = book.series
    ? `      <sequence name="${escapeXml(book.series.title)}"${
        book.series.seqNumber === null ? '' : ` number="${book.series.seqNumber}"`
      }/>\n`
    : '';

  const coverPage = book.cover
    ? `      <coverpage><image l:href="#${escapeXml(book.cover.fileName)}"/></coverpage>\n`
    : '';

  const binary = book.cover
    ? `  <binary id="${escapeXml(book.cover.fileName)}" content-type="${escapeXml(
        book.cover.contentType,
      )}">${book.cover.base64}</binary>\n`
    : '';

  const body = book.paragraphs
    .map((paragraph) => `      <p>${escapeXml(paragraph)}</p>`)
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
${genres}
${authors}
      <book-title>${escapeXml(book.title)}</book-title>
${annotation}${keywords}${coverPage}      <lang>${escapeXml(book.lang)}</lang>
${sequence}${book.year === null ? '' : `      <date value="${book.year}-01-01">${book.year}</date>\n`}    </title-info>
    <document-info>
      <program-used>flibrary-web fixtures</program-used>
      <version>1.0</version>
    </document-info>
  </description>
  <body>
    <title><p>${escapeXml(book.title)}</p></title>
    <section>
${body}
    </section>
  </body>
${binary}</FictionBook>
`;
}

/**
 * Крошечный валидный JPEG 8x8 (серый градиент) — как обложка.
 * Реальные картинки в фикстурах не нужны, важно лишь чтобы формат распознавался.
 */
export const SAMPLE_COVER_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AL+AAAAAAAAAAf/Z';
