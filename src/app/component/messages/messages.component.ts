import { Component, OnDestroy, OnInit } from '@angular/core';
import {
  Observable,
  of,
  combineLatest,
  Subscription,
  firstValueFrom,
} from 'rxjs';
import { map, switchMap, filter, take } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { ClassService } from 'src/app/shared/class.service';
import { MessageService, ClassMessage } from 'src/app/shared/message.service';
import { User, UserClassIndex } from 'src/app/model/user';

@Component({
  selector: 'app-messages',
  templateUrl: './messages.component.html',
})
export class MessagesComponent implements OnInit, OnDestroy {
  me$!: Observable<User | null>;
  myIndex$!: Observable<UserClassIndex[]>;
  classIds$!: Observable<string[]>;
  messages$!: Observable<ClassMessageWithMeta[]>;
  private messagesRaw$!: Observable<ClassMessage[]>;

  newMessage = '';
  selectedClassId = '';
  sending = false;
  errorMsg = '';

  isAdmin$!: Observable<boolean>;
  private sub?: Subscription;

  constructor(
    private auth: AuthService,
    private classes: ClassService,
    private msg: MessageService
  ) {}

  ngOnInit(): void {
    // Always use effective identity
    this.me$ = this.auth.effectiveUser$;

    this.isAdmin$ = this.auth.effectiveUser$.pipe(
      map((u) => (u?.platformRole || '').toLowerCase() === 'admin')
    );

    // Get my class index; if I'm a managed child with empty index, fallback to owner's index
    this.myIndex$ = this.auth.effectiveUser$.pipe(
      switchMap((me) => {
        if (!me?.uid) return of([]);
        return this.classes.userClassIndex$(me.uid).pipe(
          switchMap((myIdx) => {
            // If child has no own index, try owner's
            if (
              myIdx.length === 0 &&
              (me as any).isManagedChild &&
              (me as any).ownerUid
            ) {
              return this.classes.userClassIndex$((me as any).ownerUid).pipe(
                // If your index items carry memberUid, keep only those for this child
                map((ownerIdx) =>
                  ownerIdx.filter(
                    (x: any) => !('memberUid' in x) || x.memberUid === me.uid
                  )
                )
              );
            }
            return of(myIdx);
          })
        );
      })
    );

    this.classIds$ = this.myIndex$.pipe(
      map((list) => list.map((x) => x.classId))
    );

    // Auto-select first class
    this.sub = this.myIndex$.subscribe((idx) => {
      if (!this.selectedClassId && idx?.length)
        this.selectedClassId = idx[0].classId;
    });

    const titleMap$ = this.myIndex$.pipe(
      map((list) =>
        Object.fromEntries(list.map((x) => [x.classId, x.title || x.classId]))
      )
    );

    // Raw feed across classes (make sure your service chunks 'in' queries, see §2)
    this.messagesRaw$ = this.classIds$.pipe(
      switchMap((ids) =>
        ids.length ? this.msg.messagesAcrossClasses$(ids, 40) : of([])
      )
    );

    this.messages$ = combineLatest([this.messagesRaw$, titleMap$]).pipe(
      map(([msgs, titles]) =>
        msgs.map((m) => ({
          ...m,
          classTitle: titles[m.classId] || m.classId,
          createdAtDate: m.createdAt?.toDate
            ? m.createdAt.toDate()
            : new Date(0),
        }))
      )
    );

    // Mark seen with effective UID
    this.sub.add(
      combineLatest([this.auth.effectiveUid$, this.classIds$]).subscribe(
        async ([uid, ids]) => {
          if (uid && ids.length) await this.msg.markAllSeen(uid, ids);
        }
      )
    );
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  async send() {
    this.errorMsg = '';
    if (!this.selectedClassId) {
      this.errorMsg = 'Sélectionnez une classe.';
      return;
    }
    if (!this.newMessage.trim()) {
      this.errorMsg = 'Le message est vide.';
      return;
    }

    this.sending = true;
    try {
      const me = await firstValueFrom(this.auth.effectiveUser$.pipe(take(1)));
      if (!me?.uid) {
        this.errorMsg = 'Non authentifié.';
        return;
      }

      await this.msg.sendMessage(this.selectedClassId, this.newMessage.trim());
      this.newMessage = '';
      await this.msg.markClassSeen(me.uid, this.selectedClassId);
    } catch (e: any) {
      // Most common: Firestore rules denial if not admin/instructor
      this.errorMsg = e?.message || 'Échec de la publication.';
      console.error('[messages] send failed:', e);
    } finally {
      this.sending = false;
    }
  }
}

interface ClassMessageWithMeta extends ClassMessage {
  classTitle: string;
  createdAtDate: Date;
}
