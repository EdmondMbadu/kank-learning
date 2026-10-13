import { QuizQuestion } from '../../model/user';

export type ImportedQuizQuestion = QuizQuestion & {
  kind: NonNullable<QuizQuestion['kind']>;
};

export class QuizCsvError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('\n'));
  }
}

interface CsvRow {
  cells: string[];
  line: number;
}

// Parse quoted cells, escaped quotes and multiline questions without splitting
// on commas inside a cell. French spreadsheet exports may use semicolons.
function readCsv(source: string, delimiter: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let rowLine = 1;
  const finishCell = () => {
    cells.push(cell.trim());
    cell = '';
    closedQuote = false;
  };
  const finishRow = () => {
    finishCell();
    if (cells.some((value) => value !== '')) rows.push({ cells, line: rowLine });
    cells = [];
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && source[i + 1] === '\n') i++;
        cell += '\n';
        line++;
      } else cell += char;
    } else if (char === delimiter) {
      finishCell();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      finishRow();
      line++;
      rowLine = line;
    } else if (char === '"') {
      if (cell.trim() || closedQuote) {
        throw new QuizCsvError([`Ligne ${line} : guillemet inattendu.`]);
      }
      cell = '';
      quoted = true;
    } else if (closedQuote) {
      if (char.trim()) {
        throw new QuizCsvError([`Ligne ${line} : caractère après un guillemet fermant.`]);
      }
    } else cell += char;
  }
  if (quoted) throw new QuizCsvError([`Ligne ${rowLine} : guillemets non fermés.`]);
  finishRow();
  return rows;
}

export function parseQuizCsv(source: string): ImportedQuizQuestion[] {
  source = source.replace(/^\uFEFF/, '');
  if (source.includes('\uFFFD')) {
    throw new QuizCsvError(['Encodage invalide. Exportez le fichier au format CSV UTF-8.']);
  }
  // The header has no data punctuation; choose its separator only.
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows = readCsv(source, delimiter);
  if (rows.length < 2) throw new QuizCsvError(['Le fichier doit contenir un en-tête et au moins une question.']);
  const headers = rows[0].cells.map((header) => header.toLowerCase());
  const required = ['question', 'type', 'reponse_correcte'];
  const headerErrors = required.filter((header) => !headers.includes(header))
    .map((header) => `Colonne requise manquante : ${header}.`);
  if (new Set(headers).size !== headers.length) headerErrors.push('Les noms de colonnes doivent être uniques.');
  const choiceColumns = headers.map((header, index) => ({
    index, number: /^choix_([1-9]\d*)$/.exec(header)?.[1],
  })).filter((column) => column.number).sort((a, b) => Number(a.number) - Number(b.number));
  const allowed = new Set([...required, 'image_url', ...choiceColumns.map((column) => headers[column.index])]);
  headers.filter((header) => !allowed.has(header)).forEach((header) =>
    headerErrors.push(`Colonne inconnue : ${header || '(vide)'}. Utilisez le modèle CSV.`));
  if (choiceColumns.some((column, index) => Number(column.number) !== index + 1)) {
    headerErrors.push('Numérotez les colonnes de choix sans saut : choix_1, choix_2, etc.');
  }
  if (headerErrors.length) throw new QuizCsvError(headerErrors);

  const errors: string[] = [];
  const questions: ImportedQuizQuestion[] = [];
  for (const row of rows.slice(1)) {
    const fail = (message: string) => { errors.push(`Ligne ${row.line} : ${message}`); };
    if (row.cells.length !== headers.length) {
      fail(`attendu ${headers.length} colonnes, trouvé ${row.cells.length}.`);
      continue;
    }
    const value = (header: string) => row.cells[headers.indexOf(header)] || '';
    const prompt = value('question');
    const kind = value('type').toLowerCase();
    const answer = value('reponse_correcte');
    const imageUrl = value('image_url');
    const rowErrorCount = errors.length;
    if (!prompt) fail('énoncé de la question requis.');
    if (!['mcq-single', 'mcq-multi', 'text'].includes(kind)) {
      fail('type invalide. Utilisez mcq-single, mcq-multi ou text.');
      continue;
    }
    if (imageUrl) {
      try {
        const url = new URL(imageUrl);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
      } catch { fail('image_url doit être une URL http ou https valide.'); }
    }
    const base = { id: '', prompt, ...(imageUrl ? { imageUrl } : {}) };
    if (kind === 'text') {
      if (!answer) fail('réponse texte attendue requise.');
      if (choiceColumns.some((column) => row.cells[column.index])) {
        fail('laissez les choix vides pour une réponse texte.');
      }
      if (errors.length === rowErrorCount) questions.push({ ...base, kind, correctText: answer });
      continue;
    }
    const choices = choiceColumns.map((column) => row.cells[column.index]);
    while (choices.length && !choices[choices.length - 1]) choices.pop();
    if (choices.length < 2 || choices.some((choice) => !choice)) {
      fail('au moins deux choix consécutifs sont requis, sans cellule vide entre eux.');
    }
    const parts = answer.split('|').map((part) => part.trim());
    const indices = parts.map((part) => Number(part) - 1);
    if (parts.some((part) => !/^[1-9]\d*$/.test(part)) ||
        indices.some((index) => index < 0 || index >= choices.length) ||
        new Set(indices).size !== indices.length ||
        (kind === 'mcq-single' && indices.length !== 1)) {
      fail(kind === 'mcq-single'
        ? 'reponse_correcte doit contenir un seul numéro de choix valide (ex. : 2).'
        : 'reponse_correcte doit contenir des numéros de choix valides et uniques séparés par | (ex. : 1|3).');
    }
    if (errors.length === rowErrorCount) questions.push(kind === 'mcq-single'
      ? { ...base, kind, choices, correct: indices[0], correctIndex: indices[0] }
      : { ...base, kind: 'mcq-multi', choices, correctMulti: indices.sort((a, b) => a - b) });
  }
  // Reject the whole file so a malformed answer never creates a partial quiz.
  if (errors.length) throw new QuizCsvError(errors);
  return questions;
}
