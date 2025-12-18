import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { map, switchMap } from 'rxjs/operators';
import { firstValueFrom, Observable, of } from 'rxjs';
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
  // async startAttemptIfNeeded(
  //   classId: string,
  //   assignmentId: string,
  //   uid: string,
  //   opts?: { forceNew?: boolean }
  // ) {
  //   const aRef = this.afs.doc<QuizAssignment>(
  //     `classes/${classId}/assignments/${assignmentId}`
  //   ).ref;
  //   const tRef = this.afs.doc<QuizAttempt>(
  //     `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
  //   ).ref;

  //   await this.afs.firestore.runTransaction(async (tx) => {
  //     const [aDoc, tDoc] = await Promise.all([tx.get(aRef), tx.get(tRef)]);
  //     if (!aDoc.exists) throw new Error('Assignment introuvable.');
  //     const a = aDoc.data() as any;
  //     // NEW: restrict if audience is 'subset'
  //     const audience: 'all' | 'subset' = (a?.audience as any) ?? 'all';
  //     if (audience === 'subset') {
  //       const allowed =
  //         Array.isArray(a?.assignedTo) && a.assignedTo.includes(uid);
  //       if (!allowed) {
  //         throw new Error('Vous ne pouvez pas accéder à ce quiz.');
  //       }
  //     }

  //     const nowMs = Date.now();
  //     const timeLimitMs =
  //       a?.timed && a?.timeLimitSec ? a.timeLimitSec * 1000 : 0;

  //     const pickIds = (ids: string[], n: number) => {
  //       const copy = ids.slice();
  //       for (let i = copy.length - 1; i > 0; i--) {
  //         const j = Math.floor(Math.random() * (i + 1));
  //         [copy[i], copy[j]] = [copy[j], copy[i]];
  //       }
  //       return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
  //     };

  //     // helper: compute initial answers per question kind
  //     const makeInitialAnswers = (selectedIds: string[]) => {
  //       const pool: any[] = Array.isArray(a?.pool) ? a.pool : [];
  //       const byId = new Map(pool.map((q: any) => [q.id, q]));
  //       return selectedIds.map((id) => {
  //         const q = byId.get(id);
  //         const kind: 'mcq-single' | 'mcq-multi' | 'text' =
  //           (q?.kind as any) ??
  //           (Array.isArray(q?.choices) ? 'mcq-single' : 'text');
  //         if (kind === 'mcq-multi') return [] as number[];
  //         if (kind === 'text') return '';
  //         return -1; // mcq-single sentinel
  //       });
  //     };

  //     const poolIds = (Array.isArray(a?.pool) ? a.pool : []).map(
  //       (q: any) => q.id
  //     );
  //     const newSelectedIds = pickIds(poolIds, a.numQuestions);
  //     const newAnswers = makeInitialAnswers(newSelectedIds);
  //     const newExpiresAt =
  //       timeLimitMs > 0
  //         ? firebase.firestore.Timestamp.fromMillis(nowMs + timeLimitMs)
  //         : null;

  //     if (!tDoc.exists) {
  //       // first attempt
  //       tx.set(tRef, {
  //         uid,
  //         selectedIds: newSelectedIds,
  //         answers: newAnswers,
  //         score: null,
  //         startedAt: firebase.firestore.FieldValue.serverTimestamp(),
  //         expiresAt: newExpiresAt,
  //         status: 'in-progress',
  //         attemptCount: 0, // per-user counter (incremented on submit)
  //         history: [], // keep previous runs
  //         updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  //       } as any);
  //       return;
  //     }

  //     const t = tDoc.data() as any;
  //     const alreadyDone = t?.status === 'submitted' || t?.status === 'expired';

  //     if (opts?.forceNew || alreadyDone) {
  //       // start a fresh run (retake): reset selection/answers/timer, keep counters/history
  //       tx.update(tRef, {
  //         selectedIds: newSelectedIds,
  //         answers: newAnswers,
  //         score: null,
  //         startedAt: firebase.firestore.FieldValue.serverTimestamp(),
  //         expiresAt: newExpiresAt,
  //         status: 'in-progress',
  //         updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  //       });
  //       return;
  //     }

  //     // legacy: if timed but no expiresAt, set it once; otherwise do nothing
  //     const hasExpires = !!t?.expiresAt;
  //     if (a?.timed && !hasExpires && timeLimitMs > 0) {
  //       tx.update(tRef, {
  //         startedAt:
  //           t?.startedAt ?? firebase.firestore.FieldValue.serverTimestamp(),
  //         expiresAt: newExpiresAt,
  //         status: 'in-progress',
  //         updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  //       });
  //     }
  //   });
  // }

  /** Ensure an attempt exists or start a fresh run (retake) respecting audience/timing/maxAttempts. */
  async startAttemptIfNeeded(
    classId: string,
    assignmentId: string,
    uid: string,
    opts?: { forceNew?: boolean }
  ) {
    const aRef = this.afs.doc<QuizAssignment>(
      `classes/${classId}/assignments/${assignmentId}`
    ).ref;

    const tRef = this.afs.doc<QuizAttempt>(
      `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
    ).ref;

    await this.afs.firestore.runTransaction(async (tx) => {
      const [aDoc, tDoc] = await Promise.all([tx.get(aRef), tx.get(tRef)]);
      if (!aDoc.exists) throw new Error('Assignment introuvable.');

      const a = aDoc.data() as any;

      // Audience gate
      const audience: 'all' | 'subset' = (a?.audience as any) ?? 'all';
      if (audience === 'subset') {
        const allowed =
          Array.isArray(a?.assignedTo) && a.assignedTo.includes(uid);
        if (!allowed) throw new Error('Vous ne pouvez pas accéder à ce quiz.');
      }

      // Timing
      const nowMs = Date.now();
      const timeLimitMs =
        a?.timed && a?.timeLimitSec ? a.timeLimitSec * 1000 : 0;

      // Helpers (same as your current code)
      const pickIds = (ids: string[], n: number) => {
        const copy = ids.slice();
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
      };

      const makeInitialAnswers = (selectedIds: string[]) => {
        const pool: any[] = Array.isArray(a?.pool) ? a.pool : [];
        const byId = new Map(pool.map((q: any) => [q.id, q]));
        return selectedIds.map((id) => {
          const q = byId.get(id);
          const kind: 'mcq-single' | 'mcq-multi' | 'text' =
            (q?.kind as any) ??
            (Array.isArray(q?.choices) ? 'mcq-single' : 'text');
          if (kind === 'mcq-multi') return [] as number[];
          if (kind === 'text') return '';
          return -1; // mcq-single placeholder
        });
      };

      const poolIds = (Array.isArray(a?.pool) ? a.pool : []).map(
        (q: any) => q.id
      );
      const newSelectedIds = pickIds(poolIds, a.numQuestions);
      const newAnswers = makeInitialAnswers(newSelectedIds);
      const newExpiresAt =
        timeLimitMs > 0
          ? firebase.firestore.Timestamp.fromMillis(nowMs + timeLimitMs)
          : null;

      const max = Number(a?.maxAttempts || 0);

      // === No attempt yet: create first one (always allowed if max==0 or >=1) ===
      if (!tDoc.exists) {
        if (max > 0) {
          const used = 0; // first run
          if (used >= max) {
            const err: any = new Error('Max attempts reached');
            err.code = 'attempts-exhausted';
            throw err;
          }
        }

        tx.set(tRef, {
          uid,
          selectedIds: newSelectedIds,
          answers: newAnswers,
          score: null,
          startedAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: newExpiresAt,
          status: 'in-progress',
          attemptCount: 0, // incremented on submit
          history: [],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        } as any);
        return;
      }

      // There is an attempt doc already
      const t = tDoc.data() as any;
      const status: string | undefined = t?.status;

      // If in-progress → this is a "continue"; DO NOT enforce cap; just ensure timer exists for timed quizzes.
      if (status === 'in-progress') {
        if (a?.timed && !t?.expiresAt && timeLimitMs > 0) {
          tx.update(tRef, {
            startedAt:
              t?.startedAt ?? firebase.firestore.FieldValue.serverTimestamp(),
            expiresAt: newExpiresAt,
            status: 'in-progress',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        }
        return; // continue
      }

      // Otherwise, user wants to start a fresh run (retake)
      const wantsFreshRun = !!(
        opts?.forceNew ||
        status === 'submitted' ||
        status === 'expired'
      );

      if (wantsFreshRun) {
        if (max > 0) {
          const used = this.computeUsedAttempts(t);
          if (used >= max) {
            const err: any = new Error('Max attempts reached');
            err.code = 'attempts-exhausted';
            throw err;
          }
        }

        // Start a fresh run but KEEP the previous score/grade metadata
        tx.update(tRef, {
          selectedIds: newSelectedIds,
          answers: newAnswers,
          // score: null,            // ← remove this line
          // submittedAt / gradedAt (if you store them) are intentionally left intact
          startedAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: newExpiresAt,
          status: 'in-progress',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      // Legacy timed fix-up: if somehow timed but missing expiresAt, set once
      if (a?.timed && !t?.expiresAt && timeLimitMs > 0) {
        tx.update(tRef, {
          startedAt:
            t?.startedAt ?? firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: newExpiresAt,
          status: 'in-progress',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
  }
  // assignment.service.ts
  assignmentsForUser$(classId: string, uid: string) {
    return this.assignments$(classId).pipe(
      map((list) =>
        (list ?? []).filter(
          (a: any) =>
            (a?.audience ?? 'all') !== 'subset' ||
            (Array.isArray(a?.assignedTo) && a.assignedTo.includes(uid))
        )
      )
    );
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

  // Add these to the opts signature:
  async createCustomQuiz(
    classId: string,
    createdByUid: string,
    title: string,
    pool: QuizQuestion[],
    points?: number,
    opts?: {
      timed?: boolean;
      timeLimitSec?: number;
      audience?: 'all' | 'subset';
      assignedTo?: string[];
      maxAttempts?: number | null; // allow null from the caller
    }
  ): Promise<string> {
    if (!title?.trim()) throw new Error('Titre requis');
    if (!pool?.length) throw new Error('Ajoutez au moins une question');

    const id = this.afs.createId();
    const now = firebase.firestore.FieldValue.serverTimestamp();

    const a: any = {
      id,
      classId,
      title: title.trim(),
      type: 'quiz',
      createdBy: createdByUid,
      createdAt: now,
      updatedAt: now,
      pool,
      numQuestions: pool.length,
      points: points ?? pool.length,
      timed: !!opts?.timed,
      timeLimitSec: opts?.timed ? opts?.timeLimitSec ?? 0 : null,
      audience: opts?.audience ?? 'all',
      assignedTo:
        opts?.audience === 'subset'
          ? Array.from(new Set(opts?.assignedTo ?? []))
          : [],
      // DO NOT set maxAttempts if it's null/undefined/<=0
      ...(typeof opts?.maxAttempts === 'number' && opts.maxAttempts > 0
        ? { maxAttempts: Math.floor(opts.maxAttempts) }
        : {}),
    };

    await this.afs
      .doc(`classes/${classId}/assignments/${id}`)
      .set(this.stripUndefined(a));
    return id;
  }
  private stripUndefined<T extends Record<string, any>>(obj: T): T {
    for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
    return obj;
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
    // if (!(await this.canEditAttempt(ref))) return;
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
  // assignment.service.ts
  async submitAndGrade(
    classId: string,
    assignmentId: string,
    uid: string
  ): Promise<{
    score: number;
    total: number;
    status: 'submitted' | 'expired';
  }> {
    return await this.afs.firestore.runTransaction(async (tx) => {
      const aRef = this.afs.doc(
        `classes/${classId}/assignments/${assignmentId}`
      ).ref;
      const tRef = this.afs.doc(
        `classes/${classId}/assignments/${assignmentId}/attempts/${uid}`
      ).ref;

      const [aSnap, tSnap] = await Promise.all([tx.get(aRef), tx.get(tRef)]);
      if (!aSnap.exists) throw new Error('Quiz introuvable');
      if (!tSnap.exists) throw new Error('Aucune tentative');

      const a = aSnap.data() as any;
      const pool: QuizQuestion[] = Array.isArray(a?.pool) ? a.pool : [];
      const t = tSnap.data() as any;

      const selectedIds: string[] = Array.isArray(t?.selectedIds)
        ? t.selectedIds
        : [];
      const answers: any[] = Array.isArray(t?.answers) ? t.answers : [];
      const expiresAt: firebase.firestore.Timestamp | null =
        t?.expiresAt || null;

      const isExpired =
        !!a?.timed && !!expiresAt && Date.now() > expiresAt.toMillis();

      const byId = new Map(pool.map((q: any) => [q.id, q]));
      let score = 0;
      for (let i = 0; i < selectedIds.length; i++) {
        const q = byId.get(selectedIds[i]);
        const ans = answers[i];
        if (!q) continue;
        const kind: 'mcq-single' | 'mcq-multi' | 'text' =
          (q.kind as any) ?? (Array.isArray(q.choices) ? 'mcq-single' : 'text');

        if (kind === 'mcq-single') {
          const expected = (q as any).correct ?? (q as any).correctIndex;
          if (
            typeof ans === 'number' &&
            typeof expected === 'number' &&
            ans === expected
          )
            score++;
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
          )
            score++;
        } else {
          const ok =
            typeof ans === 'string' &&
            norm(ans) === norm((q as any).correctText ?? '');
          if (ok) score++;
        }
      }

      const finalStatus: 'submitted' | 'expired' = isExpired
        ? 'expired'
        : 'submitted';
      const prevUserCount = t?.attemptCount ?? 0;

      const startedAt: firebase.firestore.Timestamp | null =
        t?.startedAt ?? null;
      const submittedAt = firebase.firestore.Timestamp.now();
      const durationMs =
        startedAt instanceof firebase.firestore.Timestamp
          ? Math.max(0, submittedAt.toMillis() - startedAt.toMillis())
          : null;

      const historyEntry = {
        score,
        selectedIds,
        answers,
        status: finalStatus,
        attemptNo: prevUserCount + 1,
        submittedAt, // client timestamp inside array item
        startedAt,
        durationMs,
      };

      tx.update(tRef, {
        score,
        status: finalStatus,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
        gradedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        attemptCount: prevUserCount + 1,
        history: firebase.firestore.FieldValue.arrayUnion(historyEntry),
      });

      tx.update(aRef, {
        attemptCount: firebase.firestore.FieldValue.increment(1),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      return {
        score,
        total: selectedIds.length || (a?.numQuestions ?? 0),
        status: finalStatus,
      };
    });
  }

  async canEditAttempt(ref: firebase.firestore.DocumentReference) {
    const snap = await ref.get();
    if (!snap.exists) return false;
    const t = snap.data() as any;
    const status = t?.status;
    const expiresAt: firebase.firestore.Timestamp | null = t?.expiresAt || null;
    const expired = expiresAt && Date.now() >= expiresAt.toMillis();
    return status !== 'submitted' && status !== 'expired' && !expired;
  }
  assignment$(classId: string, assignmentId: string) {
    return this.afs
      .doc<QuizAssignment>(`classes/${classId}/assignments/${assignmentId}`)
      .valueChanges({ idField: 'id' });
  }

  // Returns every attempt document (one per user) for an assignment,
  // with no filtering — includes attemptCount and history[] so you
  // can show per-user retake counts.
  attemptsForAssignmentAll$(classId: string, assignmentId: string) {
    const path = `classes/${classId}/assignments/${assignmentId}/attempts`;
    return this.afs
      .collection<QuizAttempt>(path, (ref) =>
        // order by a field you always set; updatedAt is set on create/update
        ref.orderBy('updatedAt', 'desc')
      )
      .valueChanges({ idField: 'uid' });
  }

  // Inside AssignmentService

  /** Strong attempt counter that merges attemptCount, history[], status, and in-progress evidence. */
  private computeUsedAttempts(att: any | null | undefined): number {
    if (!att) return 0;

    const field = typeof att?.attemptCount === 'number' ? att.attemptCount : 0;
    const histLen = Array.isArray(att?.history) ? att.history.length : 0;
    const maxNo = Array.isArray(att?.history)
      ? Math.max(
          0,
          ...att.history.map((h: any) =>
            typeof h?.attemptNo === 'number' ? h.attemptNo : 0
          )
        )
      : 0;

    // any sign of at least one submission
    const hasAnySubmitted =
      att?.status === 'submitted' ||
      att?.status === 'expired' ||
      att?.score != null ||
      !!att?.submittedAt;

    // strongest submitted signal
    const submitted = Math.max(field, histLen, maxNo, hasAnySubmitted ? 1 : 0);

    // detect a *fresh* in-progress run that isn’t yet counted in submitted
    const lastSubmittedMs = Array.isArray(att?.history)
      ? att.history.reduce(
          (m: number, h: any) =>
            Math.max(m, h?.submittedAt?.toDate?.()?.getTime?.() ?? 0),
          0
        )
      : 0;

    const startedMs = att?.startedAt?.toDate?.()?.getTime?.() ?? 0;
    const hasFreshUnsubmittedRun =
      att?.status === 'in-progress' && startedMs > lastSubmittedMs;

    // extra fallback: if answers exist and nothing counted yet, treat as 1
    const hasAnyAnswers =
      Array.isArray(att?.answers) &&
      att.answers.some(
        (ans: any) =>
          (typeof ans === 'number' && ans >= 0) ||
          (Array.isArray(ans) && ans.length > 0) ||
          (typeof ans === 'string' && ans.trim().length > 0)
      );

    const addUnsubmitted =
      hasFreshUnsubmittedRun ||
      (submitted === 0 && (att?.status === 'in-progress' || hasAnyAnswers));

    return submitted + (addUnsubmitted ? 1 : 0);
  }

  async getCustomQuizForEdit(classId: string, aid: string): Promise<any> {
    return await firstValueFrom(
      this.afs.doc(`classes/${classId}/assignments/${aid}`).valueChanges()
    );
  }

  async getCustomQuizQuestions(classId: string, aid: string): Promise<any[]> {
    // Use if you store questions in a subcollection
    return await firstValueFrom(
      this.afs
        .collection(`classes/${classId}/assignments/${aid}/questions`)
        .valueChanges({ idField: 'id' })
    );
  }

  async updateCustomQuiz(
    classId: string,
    aid: string,
    title: string,
    questions: any[],
    points: number | undefined,
    opts: {
      timed?: boolean;
      timeLimitSec?: number;
      audience: 'all' | 'subset';
      assignedTo: string[];
      maxAttempts: number;
    }
  ) {
    // Normalize: keep compatibility with grader (accepts correct OR correctIndex)
    const pool = questions.map((q) => ({
      ...q,
      // if editor produced `correct`, mirror it to `correctIndex` for older consumers
      ...(typeof q.correct === 'number' && typeof q.correctIndex !== 'number'
        ? { correctIndex: q.correct }
        : {}),
    }));

    await this.afs.doc(`classes/${classId}/assignments/${aid}`).update({
      title,
      points: points ?? null,
      numQuestions: pool.length,
      timed: !!opts.timed,
      timeLimitSec: opts.timeLimitSec ?? null,
      audience: opts.audience,
      assignedTo: opts.assignedTo,
      maxAttempts: opts.maxAttempts,
      pool, // ✅ write to POOL (the single source of truth)
      updatedAt: new Date(),
      questions: firebase.firestore.FieldValue.delete(), // ✅ remove old field if present
    });
  }
}

// --- util (file-local) ---
function pickRandomIds(ids: string[], n: number) {
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, ids.length));
}
