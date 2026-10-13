import type { jsPDF } from 'jspdf';
import { QuizQuestion } from '../../model/user';

export interface QuizPdfContent {
  title: string;
  questions: QuizQuestion[];
  points?: number;
  timed?: boolean;
  timeLimitSec?: number;
}

export function quizPdfFilename(title: string, includeAnswers: boolean): string {
  const name = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'quiz';
  return `${name}-${includeAnswers ? 'avec-reponses' : 'questions'}.pdf`;
}

function choiceLabel(index: number): string {
  let label = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + (value - 1) % 26) + label;
  }
  return label;
}

// Helvetica's PDF character set supports French accents. Normalize punctuation
// and arrows that occur in the question bank to printable equivalents.
function printable(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, ' ').replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-').replace(/→/g, ' > ');
}

async function loadImage(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('Image introuvable');
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function createQuizPdf(
  quiz: QuizPdfContent,
  includeAnswers: boolean,
  imageLoader: (url: string) => Promise<Uint8Array> = loadImage
): Promise<jsPDF> {
  if (!quiz.questions.length) throw new Error('Ce quiz ne contient aucune question.');
  const { jsPDF: Pdf } = await import('jspdf');
  const doc = new Pdf({ unit: 'pt', format: 'a4', compress: true });
  doc.setProperties({ title: quiz.title, subject: includeAnswers ? 'Quiz avec réponses' : 'Quiz - questions seules' });
  const margin = 44;
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const contentWidth = width - margin * 2;
  const bottom = height - 54;
  let y = 52;
  const ensureSpace = (needed: number) => {
    if (y + needed > bottom) {
      doc.addPage();
      y = 52;
    }
  };
  const write = (text: string, size = 11, bold = false, indent = 0, color = '#1e293b') => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines: string[] = doc.splitTextToSize(printable(text), contentWidth - indent);
    for (const line of lines) {
      ensureSpace(size * 1.4);
      doc.text(line, margin + indent, y);
      y += size * 1.4;
    }
  };

  write(quiz.title || 'Quiz', 18, true);
  y += 4;
  write(includeAnswers ? 'AVEC LES RÉPONSES' : 'QUESTIONS SEULES', 10, true, 0, '#475569');
  const meta = [`${quiz.questions.length} questions`, `${quiz.points ?? quiz.questions.length} points`];
  if (quiz.timed && quiz.timeLimitSec) meta.push(`Durée : ${Math.round(quiz.timeLimitSec / 60)} min`);
  write(meta.join('  |  '), 10, false, 0, '#475569');
  y += 14;
  if (!includeAnswers) {
    write('Nom : ____________________________________    Date : ______________', 10);
    y += 8;
  }

  for (const [index, question] of quiz.questions.entries()) {
    const kind = question.kind || (question.choices?.length
      ? (question.correctMulti ? 'mcq-multi' : 'mcq-single') : 'text');
    const choices = question.choices || [];
    let answer = '';
    if (includeAnswers) {
      if (kind === 'text') {
        answer = question.correctText?.trim() || '';
      } else {
        const indices = kind === 'mcq-multi' ? question.correctMulti || [] : [question.correct ?? question.correctIndex ?? -1];
        if (indices.length && indices.every((i) => Number.isInteger(i) && i >= 0 && i < choices.length)) {
          answer = indices.map((i) => `${choiceLabel(i)}. ${choices[i]}`).join(' ; ');
        }
      }
      if (!answer) throw new Error(`Question ${index + 1} : bonne réponse manquante. Éditez le quiz avant de télécharger le corrigé.`);
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    const promptLines = doc.splitTextToSize(printable(`${index + 1}. ${question.prompt}`), contentWidth).length;
    // Keep short questions together; long questions continue safely across pages.
    doc.setFont('helvetica', 'normal');
    const choiceLines = choices.reduce((sum, choice) => sum + doc.splitTextToSize(printable(choice), contentWidth - 30).length, 0);
    const estimatedHeight = (promptLines + choiceLines + (includeAnswers ? 3 : kind === 'text' ? 3 : 1)) * 16 + 32;
    ensureSpace(Math.min(estimatedHeight, bottom - 52));
    write(`${index + 1}. ${question.prompt}`, 11, true);
    write(kind === 'text' ? 'Écrivez votre réponse.' : kind === 'mcq-multi'
      ? 'Cochez toutes les bonnes réponses.' : 'Cochez une seule réponse.', 9, false, 0, '#64748b');
    y += 4;

    if (question.imageUrl) {
      try {
        const image = await imageLoader(question.imageUrl);
        const props = doc.getImageProperties(image);
        const scale = Math.min(contentWidth / props.width, 160 / props.height, 1);
        const imageWidth = props.width * scale;
        const imageHeight = props.height * scale;
        ensureSpace(imageHeight + 12);
        doc.addImage(image, margin, y, imageWidth, imageHeight);
        y += imageHeight + 12;
      } catch {
        throw new Error(`Question ${index + 1} : impossible d’intégrer l’image au PDF. Vérifiez son URL et son accès.`);
      }
    }

    if (kind === 'text') {
      if (!includeAnswers) {
        for (let line = 0; line < 2; line++) {
          ensureSpace(22);
          doc.setDrawColor('#cbd5e1');
          doc.line(margin, y + 10, width - margin, y + 10);
          y += 22;
        }
      }
    } else {
      for (const [choiceIndex, choice] of choices.entries()) {
        ensureSpace(16);
        doc.setDrawColor('#64748b');
        doc.rect(margin + 8, y - 8, 7, 7);
        write(`${choiceLabel(choiceIndex)}. ${choice}`, 11, false, 24);
        y += 3;
      }
    }
    if (includeAnswers) {
      y += 5;
      write(`${kind === 'mcq-multi' ? 'Réponses correctes' : 'Réponse correcte'} : ${answer}`, 10, true, 0, '#166534');
    }
    y += 16;
  }

  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor('#64748b');
    doc.text(includeAnswers ? 'Quiz avec réponses' : 'Quiz - questions seules', margin, height - 26);
    doc.text(`${page} / ${totalPages}`, width - margin, height - 26, { align: 'right' });
  }
  return doc;
}
