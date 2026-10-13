import { createQuizPdf, quizPdfFilename } from './quiz-pdf';

describe('Quiz PDF export', () => {
  it('exports single, multiple and text questions with the saved answer mappings', async () => {
    const doc = await createQuizPdf({ title: 'Formation', questions: [
      { id: 'a', prompt: 'Choisir', choices: ['Oui', 'Non'], correctIndex: 0 },
      { id: 'b', prompt: 'Plusieurs', kind: 'mcq-multi', choices: ['2', '3', '4'], correctMulti: [0, 2] },
      { id: 'c', prompt: 'Écrire', kind: 'text', correctText: 'Réponse exacte' },
    ] }, true);
    expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(1000);
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('allows a student copy without an answer key, but refuses an incomplete corrected copy', async () => {
    const quiz = { title: 'Quiz', questions: [{ id: 'a', prompt: 'Question', choices: ['Oui', 'Non'] }] };
    expect((await createQuizPdf(quiz, false)).getNumberOfPages()).toBe(1);
    await expectAsync(createQuizPdf(quiz, true)).toBeRejectedWithError(/Question 1.*bonne réponse manquante/);
  });

  it('rejects answer indices that point outside the choices', async () => {
    await expectAsync(createQuizPdf({ title: 'Quiz', questions: [
      { id: 'a', prompt: 'Question', kind: 'mcq-multi', choices: ['Oui', 'Non'], correctMulti: [0, 2] },
    ] }, true)).toBeRejectedWithError(/bonne réponse manquante/);
  });

  it('paginates long prompts and choices instead of running off the page', async () => {
    const doc = await createQuizPdf({ title: 'Quiz long', questions: [
      { id: 'a', prompt: 'Une longue question. '.repeat(300), choices: ['Une longue réponse. '.repeat(150), 'Non'], correct: 0 },
    ] }, false);
    expect(doc.getNumberOfPages()).toBeGreaterThan(2);
  });

  it('reports inaccessible images instead of silently dropping them', async () => {
    await expectAsync(createQuizPdf({ title: 'Quiz', questions: [
      { id: 'a', prompt: 'Illustration', choices: ['Oui', 'Non'], correct: 0, imageUrl: 'https://example.com/missing.png' },
    ] }, false, async () => { throw new Error('missing'); })).toBeRejectedWithError(/Question 1.*image/);
  });

  it('rejects an empty quiz and distinguishes the two download filenames', async () => {
    await expectAsync(createQuizPdf({ title: 'Quiz', questions: [] }, false)).toBeRejectedWithError(/aucune question/);
    expect(quizPdfFilename('Évaluation / Fondation', false)).toBe('evaluation-fondation-questions.pdf');
    expect(quizPdfFilename('Évaluation / Fondation', true)).toBe('evaluation-fondation-avec-reponses.pdf');
  });
});
