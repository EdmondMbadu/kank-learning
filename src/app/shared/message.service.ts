import { Injectable } from '@angular/core';
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  where,
  onSnapshot,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  Timestamp,
  limit,
  getDocs,
} from 'firebase/firestore';
import { AuthService } from './auth.service';
import { Observable } from 'rxjs';

export interface ClassMessage {
  id?: string;
  classId: string;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: Timestamp | any;
  pinned?: boolean;
}

@Injectable({ providedIn: 'root' })
export class MessageService {
  private db = getFirestore();

  constructor(private auth: AuthService) {}

  // Stream messages of ONE class (latest first)
  messagesForClass$(classId: string, max = 100): Observable<ClassMessage[]> {
    return new Observable((obs) => {
      const ref = collection(this.db, 'classMessages', classId, 'messages');
      const q = query(ref, orderBy('createdAt', 'desc'), limit(max));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const out = snap.docs.map(
            (d) => ({ id: d.id, ...d.data() } as ClassMessage)
          );
          obs.next(out);
        },
        (err) => obs.error(err)
      );
      return () => unsub();
    });
  }

  // Stream messages ACROSS many classes (merged + sorted desc)
  messagesAcrossClasses$(
    classIds: string[],
    perClass = 50
  ): Observable<ClassMessage[]> {
    return new Observable((obs) => {
      const unsubs: (() => void)[] = [];
      let bag: Record<string, ClassMessage[]> = {};

      const emit = () => {
        // merge & sort desc by createdAt
        const all = Object.values(bag).flat();
        all.sort(
          (a, b) =>
            (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
        );
        obs.next(all);
      };

      classIds.forEach((cid) => {
        const ref = collection(this.db, 'classMessages', cid, 'messages');
        const q = query(ref, orderBy('createdAt', 'desc'), limit(perClass));
        const u = onSnapshot(
          q,
          (snap) => {
            bag[cid] = snap.docs.map(
              (d) => ({ id: d.id, ...d.data() } as ClassMessage)
            );
            emit();
          },
          (e) => obs.error(e)
        );
        unsubs.push(u);
      });

      return () => unsubs.forEach((u) => u());
    });
  }

  async sendMessage(classId: string, text: string) {
    const me = await this.auth.user$.pipe().toPromise();
    if (!me?.uid) throw new Error('Not authenticated');
    const ref = collection(this.db, 'classMessages', classId, 'messages');
    await addDoc(ref, {
      text: text.trim(),
      classId,
      authorId: me.uid,
      authorName:
        me.firstName || me.lastName
          ? `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim()
          : me.email || 'Admin',
      createdAt: serverTimestamp(),
    } as ClassMessage);
  }

  // --- Unread tracking ---

  private lastSeenDoc(uid: string, classId: string) {
    return doc(this.db, 'userMessageState', uid, 'classes', classId);
  }

  async markClassSeen(uid: string, classId: string) {
    const d = this.lastSeenDoc(uid, classId);
    const snap = await getDoc(d);
    if (snap.exists()) {
      await updateDoc(d, { lastSeenAt: serverTimestamp() });
    } else {
      await setDoc(d, { lastSeenAt: serverTimestamp() });
    }
  }

  async markAllSeen(uid: string, classIds: string[]) {
    await Promise.all(classIds.map((cid) => this.markClassSeen(uid, cid)));
  }

  // Live unread count for ONE class (subscribes to messages newer than lastSeenAt)
  unreadForClass$(uid: string, classId: string): Observable<number> {
    return new Observable((obs) => {
      let stopMsgs: (() => void) | null = null;

      const d = this.lastSeenDoc(uid, classId);
      const stopSeen = onSnapshot(
        d,
        (seenSnap) => {
          const lastSeenAt = seenSnap.exists()
            ? (seenSnap.data()['lastSeenAt'] as Timestamp)
            : new Timestamp(0, 0);
          // re-subscribe messages > lastSeen
          if (stopMsgs) stopMsgs();
          const ref = collection(this.db, 'classMessages', classId, 'messages');
          const qMsgs = query(ref, where('createdAt', '>', lastSeenAt));
          stopMsgs = onSnapshot(
            qMsgs,
            (snap) => obs.next(snap.size),
            (e) => obs.error(e)
          );
        },
        (e) => obs.error(e)
      );

      return () => {
        stopSeen();
        if (stopMsgs) stopMsgs();
      };
    });
  }

  // Sum unread across many classes
  unreadTotal$(uid: string, classIds: string[]): Observable<number> {
    return new Observable((obs) => {
      if (!classIds.length) {
        obs.next(0);
        return;
      }
      const unsubs: (() => void)[] = [];
      const mapCounts: Record<string, number> = {};
      const emit = () =>
        obs.next(Object.values(mapCounts).reduce((a, b) => a + b, 0));

      classIds.forEach((cid) => {
        const u = this.unreadForClass$(uid, cid).subscribe({
          next: (n) => {
            mapCounts[cid] = n;
            emit();
          },
          error: (e) => console.error(e),
        });
        unsubs.push(() => u.unsubscribe());
      });

      return () => unsubs.forEach((fn) => fn());
    });
  }
}
