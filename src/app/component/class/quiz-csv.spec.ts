import { parseQuizCsv, QuizCsvError } from './quiz-csv';

describe('Quiz CSV import', () => {
  const header = 'question,type,choix_1,choix_2,choix_3,reponse_correcte,image_url\n';

  it('maps each question type to the existing grading fields', () => {
    const questions = parseQuizCsv(header +
      'Capitale ?,mcq-single,Paris,Lyon,,1,\n' +
      'Pairs ?,mcq-multi,2,3,4,3|1,\n' +
      '2 + 2 ?,text,,,,4,');
    expect(questions[0].correct).toBe(0);
    expect(questions[0].correctIndex).toBe(0);
    expect(questions[0].choices).toEqual(['Paris', 'Lyon']);
    expect(questions[1].correctMulti).toEqual([0, 2]);
    expect(questions[2].correctText).toBe('4');
    expect(questions[2].choices).toBeUndefined();
  });

  it('preserves accents, quoted commas, escaped quotes and multiline prompts', () => {
    const questions = parseQuizCsv('\uFEFF' + header.replace(/\n$/, '\r\n') +
      '"Énoncé, avec ""citation""\r\net suite",mcq-single,"Oui, bien sûr",Non,,1,https://example.com/image.png\r\n');
    expect(questions[0].prompt).toBe('Énoncé, avec "citation"\net suite');
    expect(questions[0].choices?.[0]).toBe('Oui, bien sûr');
    expect(questions[0].imageUrl).toBe('https://example.com/image.png');
  });

  it('accepts semicolon exports, reordered headers and blank lines', () => {
    const questions = parseQuizCsv('type;reponse_correcte;question;choix_2;choix_1\r\n\r\nmcq-single;2;Question ?;Non;Oui\r\n;;;;\r\n');
    expect(questions.length).toBe(1);
    expect(questions[0].choices).toEqual(['Oui', 'Non']);
    expect(questions[0].correct).toBe(1);
  });

  it('supports more than five choices and orders them numerically', () => {
    const choices = Array.from({ length: 12 }, (_, index) => `choix_${index + 1}`);
    const questions = parseQuizCsv('question,type,' + choices.join(',') + ',reponse_correcte\n' +
      'Question,mcq-single,' + choices.join(',') + ',12');
    expect(questions[0].correct).toBe(11);
    expect(questions[0].choices?.[11]).toBe('choix_12');
  });

  it('rejects missing, duplicate, unknown and nonconsecutive headers', () => {
    for (const csv of [
      'question,type\nQuestion,text',
      'question,type,reponse_correcte,type\nQuestion,text,Oui,text',
      'question,type,reponse_correcte,extra\nQuestion,text,Oui,',
      'question,type,reponse_correcte,choix_1,choix_3\nQuestion,mcq-single,1,Oui,Non',
    ]) expect(() => parseQuizCsv(csv)).toThrowError(QuizCsvError);
  });

  it('rejects invalid answers, empty internal choices and missing question data', () => {
    for (const row of [
      'Q,mcq-single,Oui,Non,,0,',
      'Q,mcq-single,Oui,Non,,3,',
      'Q,mcq-single,Oui,Non,,1|2,',
      'Q,mcq-multi,Oui,Non,,1|1,',
      'Q,mcq-multi,Oui,Non,,1.5,',
      'Q,mcq-single,Oui,,Non,3,',
      'Q,mcq-single,Oui,,,1,',
      ',mcq-single,Oui,Non,,1,',
      'Q,text,,,,,',
      'Q,text,Unexpected,,,Oui,',
      'Q,unknown,Oui,Non,,1,',
      'Q,mcq-single,Oui,Non,,1,javascript:alert(1)',
    ]) expect(() => parseQuizCsv(header + row)).toThrowError(QuizCsvError);
  });

  it('reports physical row numbers and rejects the whole file', () => {
    try {
      parseQuizCsv(header + '"Valid\nquestion",mcq-single,Oui,Non,,1,\n' +
        'Invalid,mcq-single,Oui,Non,,5,\n' +
        'Invalid,text,,,,,');
      fail('Expected import to fail');
    } catch (error) {
      expect(error instanceof QuizCsvError).toBeTrue();
      expect((error as QuizCsvError).errors.length).toBe(2);
      expect((error as QuizCsvError).errors[0]).toContain('Ligne 4');
      expect((error as QuizCsvError).errors[1]).toContain('Ligne 5');
    }
  });

  it('rejects malformed quotes, column counts, invalid encoding and empty files', () => {
    for (const csv of [
      '', header, header + '"Unclosed',
      header + 'Bad"quote,text,,,,Oui,',
      header + '"Question"trailing,text,,,,Oui,',
      header + 'Too,few,cells',
      header + 'Q,text,,,,Oui,,extra',
      header + '�,text,,,,Oui,',
    ]) expect(() => parseQuizCsv(csv)).toThrowError(QuizCsvError);
  });
});
