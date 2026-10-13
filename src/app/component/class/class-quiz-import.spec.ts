import { ClassComponent } from './class.component';

describe('Class quiz file import', () => {
  let component: ClassComponent;
  const csv = 'question,type,choix_1,choix_2,reponse_correcte\nQ,mcq-single,Oui,Non,2';
  const eventFor = (file: File) => ({ target: { files: [file], value: file.name } } as unknown as Event);

  beforeEach(() => {
    // Exercise the import boundary without subscribing to live Firebase streams.
    component = Object.create(ClassComponent.prototype);
    Object.assign(component, {
      builderQuestions: [], builderTitle: '', editingQuizId: null,
      quizImportBusy: false, quizImportErrors: [], quizImportMessage: '', quizImportRequest: 0,
    });
  });

  it('appends imported questions with unique IDs and suggests a title', async () => {
    const file = new File([csv], 'Micro-Credit.csv');
    await component.onImportQuizCsv(eventFor(file));
    await component.onImportQuizCsv(eventFor(file));
    expect(component.builderQuestions.length).toBe(2);
    expect(component.builderQuestions[0].id).not.toBe(component.builderQuestions[1].id);
    expect(component.builderQuestions[0].correct).toBe(1);
    expect(component.builderTitle).toBe('Micro Credit');
    expect(component.quizImportBusy).toBeFalse();
  });

  it('keeps the existing questions and title when validation fails', async () => {
    await component.onImportQuizCsv(eventFor(new File([csv], 'quiz.csv')));
    component.builderTitle = 'My title';
    const questions = component.builderQuestions;
    await component.onImportQuizCsv(eventFor(new File([csv + '\nInvalid,text,,,'], 'invalid.csv')));
    expect(component.builderQuestions).toBe(questions);
    expect(component.builderTitle).toBe('My title');
    expect(component.quizImportErrors.length).toBe(1);
    expect(component.quizImportMessage).toBe('');
  });

  it('rejects unsupported and oversized files before reading', async () => {
    await component.onImportQuizCsv(eventFor(new File([csv], 'quiz.xlsx')));
    expect(component.quizImportErrors[0]).toContain('.csv');
    await component.onImportQuizCsv(eventFor(new File(['x'.repeat(1024 * 1024 + 1)], 'quiz.csv')));
    expect(component.quizImportErrors[0]).toContain('1 Mo');
    expect(component.builderQuestions).toEqual([]);
  });

  it('keeps existing quiz editing separate from imports', async () => {
    component.editingQuizId = 'existing';
    await component.onImportQuizCsv(eventFor(new File([csv], 'quiz.csv')));
    expect(component.builderQuestions).toEqual([]);
  });

  it('discards a pending read when switching to edit mode', async () => {
    let complete!: (value: string) => void;
    const file = new File([], 'quiz.csv');
    spyOn(file, 'text').and.returnValue(new Promise<string>((resolve) => { complete = resolve; }));
    const pending = component.onImportQuizCsv(eventFor(file));
    component.editingQuizId = 'existing';
    complete(csv);
    await pending;
    expect(component.builderQuestions).toEqual([]);
    expect(component.quizImportBusy).toBeFalse();
  });
});
