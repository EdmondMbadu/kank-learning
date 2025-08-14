import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { map, switchMap } from 'rxjs/operators';
import { Observable, of } from 'rxjs';
import { QuizAssignment, QuizAttempt, QuizQuestion } from 'src/app/model/user';

@Injectable({ providedIn: 'root' })
export class AssignmentService {
  constructor(private afs: AngularFirestore) {}

  // --- Streams ---
  assignments$(classId: string) {
    return this.afs
      .collection<QuizAssignment>(`classes/${classId}/assignments`, (ref) =>
        ref.orderBy('createdAt', 'desc')
      )
      .valueChanges({ idField: 'id' });
  }

  attempt$(
    classId: string,
    assignmentId: string,
    uid: string
  ): Observable<QuizAttempt | null> {
    if (!uid) return of(null);
    return this.afs
      .doc<QuizAttempt>(
        `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
      )
      .valueChanges()
      .pipe(map((x) => x ?? null));
  }

  // --- Create a sample 5-question quiz quickly (instructor tool) ---
  async createQuickQuiz(classId: string, createdBy: string) {
    const id = this.afs.createId();
    const now = firebase.firestore.FieldValue.serverTimestamp();

    // Small demo pool (8 Qs); each student gets random 5
    const pool: QuizQuestion[] = [
      {
        id: 'q1',
        prompt: 'What does APR stand for?',
        choices: [
          'Annual Percentage Rate',
          'Average Periodic Rate',
          'Applied Payment Ratio',
          'Annualized Payment Rate',
        ],
        correctIndex: 0,
      },
      {
        id: 'q2',
        prompt: 'Which is a liability?',
        choices: ['Cash', 'Inventory', 'Accounts Payable', 'Revenue'],
        correctIndex: 2,
      },
      {
        id: 'q3',
        prompt: 'Compound interest grows…',
        choices: ['Linearly', 'Exponencially', 'Randomly', 'Not at all'],
        correctIndex: 1,
      },
      {
        id: 'q4',
        prompt: 'Primary key purpose?',
        choices: [
          'Speed UI',
          'Ensure row uniqueness',
          'Encrypt data',
          'Format dates',
        ],
        correctIndex: 1,
      },
      {
        id: 'q5',
        prompt: 'TLS is mainly for…',
        choices: [
          'Styling pages',
          'Data encryption in transit',
          'Storing files',
          'Server billing',
        ],
        correctIndex: 1,
      },
      {
        id: 'q6',
        prompt: 'Firestore writes in a batch are limited to…',
        choices: ['50', '200', '500', '1000'],
        correctIndex: 2,
      },
      {
        id: 'q7',
        prompt: 'Best practice for user emails?',
        choices: [
          'Store as-is',
          'Lowercase for lookups',
          'Uppercase always',
          'Hash only',
        ],
        correctIndex: 1,
      },
      {
        id: 'q8',
        prompt: 'A join table is used to…',
        choices: [
          'Cache CSS',
          'Map many-to-many',
          'Delete logs',
          'Host images',
        ],
        correctIndex: 1,
      },
    ];

    const doc: QuizAssignment = {
      id,
      classId,
      title: 'Quiz rapide (5 QCM)',
      instructions:
        'Répondez aux 5 questions. Une seule bonne réponse par question.',
      type: 'quiz',
      points: 100,
      numQuestions: 5,
      pool,
      createdBy,
      createdAt: now,
      // optional linkage fields you already have:
      // dueAt, moduleRef, etc.
    } as any;

    await this.afs.doc(`classes/${classId}/assignments/${id}`).set(doc);
    return id;
  }

  /** Ensure an attempt exists. If missing, create with 5 random IDs */
  async startAttemptIfNeeded(
    classId: string,
    assignmentId: string,
    uid: string
  ) {
    const base = this.afs.doc<QuizAssignment>(
      `classes/${classId}/assignments/${assignmentId}`
    ).ref;
    const att = this.afs.doc<QuizAttempt>(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;

    await this.afs.firestore.runTransaction(async (tx) => {
      const [aDoc, atDoc] = await Promise.all([tx.get(base), tx.get(att)]);
      if (!aDoc.exists) throw new Error('Assignment introuvable.');

      if (!atDoc.exists) {
        const a = aDoc.data() as QuizAssignment;
        const ids = pickRandomIds(
          a.pool.map((q) => q.id),
          a.numQuestions
        );
        const answers = Array(a.numQuestions).fill(-1);

        tx.set(att, {
          uid,
          selectedIds: ids,
          answers,
        } as QuizAttempt);
      }
    });
  }

  /** Persist a single answer change (optional, can also just submit once) */
  async saveAnswer(
    classId: string,
    assignmentId: string,
    uid: string,
    index: number,
    choiceIndex: number
  ) {
    const ref = this.afs.doc<QuizAttempt>(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;
    await this.afs.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() as QuizAttempt;
      const answers = [...(data.answers ?? [])];
      answers[index] = choiceIndex;
      tx.update(ref, { answers });
    });
  }

  /** Submit + auto-grade */
  async submitAndGrade(classId: string, assignmentId: string, uid: string) {
    const aRef = this.afs.doc<QuizAssignment>(
      `classes/${classId}/assignments/${assignmentId}`
    ).ref;
    const tRef = this.afs.doc<QuizAttempt>(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;

    await this.afs.firestore.runTransaction(async (tx) => {
      const [aDoc, tDoc] = await Promise.all([tx.get(aRef), tx.get(tRef)]);
      if (!aDoc.exists || !tDoc.exists) throw new Error('Données manquantes.');
      const a = aDoc.data() as QuizAssignment;
      const t = tDoc.data() as QuizAttempt;

      const key = new Map(a.pool.map((q) => [q.id, q.correctIndex]));
      const selected = t.selectedIds;
      const answers = t.answers ?? [];

      let correct = 0;
      selected.forEach((qid, i) => {
        const expected = key.get(qid);
        if (expected != null && answers[i] === expected) correct++;
      });

      const now = firebase.firestore.FieldValue.serverTimestamp();
      tx.update(tRef, {
        submittedAt: now,
        gradedAt: now,
        score: correct,
      });
    });
  }
}

// --- util (file-local) ---
function pickRandomIds(ids: string[], n: number) {
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, ids.length));
}
