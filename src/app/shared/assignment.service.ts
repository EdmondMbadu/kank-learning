import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { map, switchMap } from 'rxjs/operators';
import { Observable, of } from 'rxjs';
import { QuizAssignment, QuizAttempt, QuizQuestion } from 'src/app/model/user';

// --- ADD: helper to normalize text answers (diacritics-insensitive) ---
function norm(s: string | null | undefined) {
  return (s ?? '')
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}
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
  // async submitAndGrade(classId: string, assignmentId: string, uid: string) {
  //   const aRef = this.afs.doc<QuizAssignment>(
  //     `classes/${classId}/assignments/${assignmentId}`
  //   ).ref;
  //   const tRef = this.afs.doc<QuizAttempt>(
  //     `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
  //   ).ref;

  //   await this.afs.firestore.runTransaction(async (tx) => {
  //     const [aDoc, tDoc] = await Promise.all([tx.get(aRef), tx.get(tRef)]);
  //     if (!aDoc.exists || !tDoc.exists) throw new Error('Données manquantes.');
  //     const a = aDoc.data() as QuizAssignment;
  //     const t = tDoc.data() as QuizAttempt;

  //     const key = new Map(a.pool.map((q) => [q.id, q.correctIndex]));
  //     const selected = t.selectedIds;
  //     const answers = t.answers ?? [];

  //     let correct = 0;
  //     selected.forEach((qid, i) => {
  //       const expected = key.get(qid);
  //       if (expected != null && answers[i] === expected) correct++;
  //     });

  //     const now = firebase.firestore.FieldValue.serverTimestamp();
  //     tx.update(tRef, {
  //       submittedAt: now,
  //       gradedAt: now,
  //       score: correct,
  //     });
  //   });
  // }

  async deleteAssignment(classId: string, assignmentId: string) {
    const db = this.afs.firestore;

    // 1) Delete attempts in chunks (<=500 per batch)
    while (true) {
      const snap = await db
        .collection(`classes/${classId}/assignments/${assignmentId}/attempts`)
        .limit(500)
        .get();

      if (snap.empty) break;

      const b = db.batch();
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();

      if (snap.size < 500) break;
    }

    // 2) Delete the assignment document
    await this.afs
      .doc(`classes/${classId}/assignments/${assignmentId}`)
      .delete();
  }
  attemptsForAssignment$(classId: string, assignmentId: string) {
    return this.afs
      .collection<QuizAttempt>(
        `classes/${classId}/assignments/${assignmentId}/attempts`
      )
      .valueChanges({ idField: 'uid' })
      .pipe(
        map((list) =>
          (list ?? []).filter(
            (a) =>
              a?.score != null ||
              (a?.answers ?? []).some((x) => x != null && x >= 0)
          )
        )
      );
  }

  // --- CREATE a custom quiz with a prepared pool of questions ---
  async createCustomQuiz(
    classId: string,
    createdByUid: string,
    title: string,
    pool: QuizQuestion[],
    points?: number
  ): Promise<string> {
    if (!title?.trim()) throw new Error('Titre requis');
    if (!pool?.length) throw new Error('Ajoutez au moins une question');

    const id = this.afs.createId();
    const now = firebase.firestore.FieldValue.serverTimestamp();

    const a = {
      id,
      title: title.trim(),
      type: 'quiz',
      createdBy: createdByUid,
      createdAt: now,
      updatedAt: now,
      pool,
      numQuestions: pool.length,
      points: points ?? pool.length, // default 1 pt per question
    };

    await this.afs.doc(`classes/${classId}/assignments/${id}`).set(a);
    return id;
  }

  // --- ADD/UPDATE/DELETE questions on an existing quiz (optional utilities) ---
  async addQuestion(classId: string, assignmentId: string, q: QuizQuestion) {
    const ref = this.afs.doc(
      `classes/${classId}/assignments/${assignmentId}`
    ).ref;
    await ref.update({
      pool: firebase.firestore.FieldValue.arrayUnion(q),
      numQuestions: firebase.firestore.FieldValue.increment(1),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async removeQuestion(classId: string, assignmentId: string, q: QuizQuestion) {
    const ref = this.afs.doc(
      `classes/${classId}/assignments/${assignmentId}`
    ).ref;
    await ref.update({
      pool: firebase.firestore.FieldValue.arrayRemove(q),
      numQuestions: firebase.firestore.FieldValue.increment(-1),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  // --- SAVE answers (single, multi, text) ---
  async saveAnswerSingle(
    classId: string,
    assignmentId: string,
    uid: string,
    index: number,
    choiceIndex: number
  ) {
    const ref = this.afs.doc(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;
    await this.afs.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = (snap.exists ? snap.data() : {}) as any;
      const answers: any[] = Array.isArray(data.answers)
        ? [...data.answers]
        : [];
      answers[index] = choiceIndex; // number
      tx.set(
        ref,
        {
          ...data,
          answers,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  }

  async toggleAnswerMulti(
    classId: string,
    assignmentId: string,
    uid: string,
    index: number,
    choiceIndex: number
  ) {
    const ref = this.afs.doc(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;
    await this.afs.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = (snap.exists ? snap.data() : {}) as any;
      const answers: any[] = Array.isArray(data.answers)
        ? [...data.answers]
        : [];
      const curr = Array.isArray(answers[index])
        ? (answers[index] as number[])
        : [];
      const has = curr.includes(choiceIndex);
      const next = has
        ? curr.filter((n) => n !== choiceIndex)
        : [...curr, choiceIndex].sort((a, b) => a - b);
      answers[index] = next; // number[]
      tx.set(
        ref,
        {
          ...data,
          answers,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  }

  async saveAnswerText(
    classId: string,
    assignmentId: string,
    uid: string,
    index: number,
    text: string
  ) {
    const ref = this.afs.doc(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;
    await this.afs.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = (snap.exists ? snap.data() : {}) as any;
      const answers: any[] = Array.isArray(data.answers)
        ? [...data.answers]
        : [];
      answers[index] = (text ?? '').toString();
      tx.set(
        ref,
        {
          ...data,
          answers,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  }

  // --- SUBMIT + GRADE (supports all kinds) ---
  async submitAndGrade(classId: string, assignmentId: string, uid: string) {
    const aRef = this.afs.doc(
      `classes/${classId}/assignments/${assignmentId}`
    ).ref;
    const tRef = this.afs.doc(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;

    await this.afs.firestore.runTransaction(async (tx) => {
      const [aSnap, tSnap] = await Promise.all([tx.get(aRef), tx.get(tRef)]);
      if (!aSnap.exists) throw new Error('Quiz introuvable');
      if (!tSnap.exists) throw new Error('Aucune tentative');

      const a = aSnap.data() as any;
      const pool: QuizQuestion[] = Array.isArray(a?.pool) ? a.pool : [];

      // Build a lookup by question id
      const byId = new Map(pool.map((q) => [q.id, q]));

      const t = tSnap.data() as any;
      const selectedIds: string[] = Array.isArray(t?.selectedIds)
        ? t.selectedIds
        : [];
      const answers: any[] = Array.isArray(t?.answers) ? t.answers : [];

      let score = 0;

      for (let i = 0; i < selectedIds.length; i++) {
        const qid = selectedIds[i];
        const q = byId.get(qid);
        const ans = answers[i];

        if (!q) continue; // safety

        // Normalize kind: legacy quick-quiz had no 'kind' and used 'correctIndex'
        const kind: 'mcq-single' | 'mcq-multi' | 'text' =
          (q.kind as any) ?? (Array.isArray(q.choices) ? 'mcq-single' : 'text');

        if (kind === 'mcq-single') {
          // new builder uses q.correct; legacy uses q.correctIndex
          const expected = (q as any).correct ?? (q as any).correctIndex;
          if (
            typeof ans === 'number' &&
            typeof expected === 'number' &&
            ans === expected
          ) {
            score++;
          }
        } else if (kind === 'mcq-multi') {
          const corr = ((q as any).correctMulti ?? [])
            .slice()
            .sort((a: number, b: number) => a - b);
          const got = Array.isArray(ans)
            ? (ans as number[]).slice().sort((a, b) => a - b)
            : [];
          if (
            corr.length === got.length &&
            corr.every((v: number, idx: number) => v === got[idx])
          ) {
            score++;
          }
        } else if (kind === 'text') {
          const ok =
            typeof ans === 'string' &&
            norm(ans) === norm((q as any).correctText ?? '');
          if (ok) score++;
        }
      }

      tx.set(
        tRef,
        {
          ...t,
          score,
          submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
          gradedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  }
}

// --- util (file-local) ---
function pickRandomIds(ids: string[], n: number) {
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, ids.length));
}
