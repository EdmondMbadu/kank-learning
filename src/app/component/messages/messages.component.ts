import { Component, OnDestroy, OnInit } from '@angular/core';
import {
  Observable,
  of,
  combineLatest,
  Subscription,
  firstValueFrom,
} from 'rxjs';
import { map, switchMap, take } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { ClassService } from 'src/app/shared/class.service';
import { MessageService, ClassMessage } from 'src/app/shared/message.service';
import { User, UserClassIndex } from 'src/app/model/user';

@Component({
  selector: 'app-messages',
  templateUrl: './messages.component.html',
})
export class MessagesComponent implements OnInit, OnDestroy {
  // identity
  me$!: Observable<User | null>;
  isAdmin$!: Observable<boolean>;

  // class lists
  myIndex$!: Observable<UserClassIndex[]>; // raw index (with owner fallback)
  safeClassIds$!: Observable<string[]>; // filtered to classes the user is a member of
  visibleIndex$!: Observable<UserClassIndex[]>; // myIndex$ filtered by safe membership
  classIds$!: Observable<string[]>; // use this everywhere for queries

  // messages
  messages$!: Observable<ClassMessageWithMeta[]>;
  private messagesRaw$!: Observable<ClassMessage[]>;

  // ui
  newMessage = '';
  selectedClassId = '';
  sending = false;
  errorMsg = '';

  private sub = new Subscription();

  constructor(
    private auth: AuthService,
    private classes: ClassService,
    private msg: MessageService
  ) {}

  ngOnInit(): void {
    // Always use effective identity (handles managed subusers)
    this.me$ = this.auth.effectiveUser$;

    this.isAdmin$ = this.me$.pipe(
      map((u) => (u?.platformRole || '').toLowerCase() === 'admin')
    );

    // ---- 1) Build a raw index with owner fallback for managed children
    this.myIndex$ = this.me$.pipe(
      switchMap((me) => {
        if (!me?.uid) return of<UserClassIndex[]>([]);
        return this.classes.userClassIndex$(me.uid).pipe(
          switchMap((myIdx) => {
            // If child has no own index, try owner’s index (but we’ll still filter by membership later)
            const isChild =
              (me as any)?.isManagedChild && (me as any)?.ownerUid;
            if (myIdx.length === 0 && isChild) {
              return this.classes.userClassIndex$((me as any).ownerUid).pipe(
                map((ownerIdx) =>
                  // If your index items carry memberUid, keep only those for this child
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

    // ---- 2) Verify real membership for each class (prevents leaks to subusers)
    this.safeClassIds$ = combineLatest([this.me$, this.myIndex$]).pipe(
      switchMap(([me, idx]) => {
        if (!me?.uid) return of<string[]>([]);
        const ids = (idx || []).map((x) => x.classId);
        if (!ids.length) return of<string[]>([]);
        const checks$ = ids.map((id) =>
          this.classes
            .memberRole$(id, me.uid)
            .pipe(map((role) => (role ? id : null)))
        );
        return combineLatest(checks$).pipe(
          map((list) => list.filter((x): x is string => !!x))
        );
      })
    );

    // ---- 3) Keep only the index entries the user actually belongs to
    this.visibleIndex$ = combineLatest([
      this.myIndex$,
      this.safeClassIds$,
    ]).pipe(
      map(([idx, allowed]) => idx.filter((x) => allowed.includes(x.classId)))
    );

    // This is the canonical set of classIds for all queries
    this.classIds$ = this.safeClassIds$;

    // ---- 4) Auto-select a valid class (and keep selection valid if list changes)
    this.sub.add(
      this.visibleIndex$.subscribe((idx) => {
        if (!idx?.length) {
          this.selectedClassId = '';
          return;
        }
        const stillValid = idx.some((c) => c.classId === this.selectedClassId);
        if (!this.selectedClassId || !stillValid) {
          this.selectedClassId = idx[0].classId;
        }
      })
    );

    // Titles map for display
    const titleMap$ = this.visibleIndex$.pipe(
      map((list) =>
        Object.fromEntries(list.map((x) => [x.classId, x.title || x.classId]))
      )
    );

    // ---- 5) Messages feed across allowed classes
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

    // ---- 6) Mark all seen for allowed classes (effective uid)
    this.sub.add(
      combineLatest([this.auth.effectiveUid$, this.classIds$]).subscribe(
        async ([uid, ids]) => {
          if (uid && ids.length) {
            try {
              await this.msg.markAllSeen(uid, ids);
            } catch {}
          }
        }
      )
    );
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
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

    try {
      this.sending = true;

      const me = await firstValueFrom(this.me$.pipe(take(1)));
      if (!me?.uid) {
        this.errorMsg = 'Non authentifié.';
        return;
      }

      // extra guard: ensure selected class is allowed
      const allowed = await firstValueFrom(this.classIds$.pipe(take(1)));
      if (!allowed.includes(this.selectedClassId)) {
        this.errorMsg = "Vous n'appartenez pas à cette classe.";
        return;
      }

      await this.msg.sendMessage(this.selectedClassId, this.newMessage.trim());
      this.newMessage = '';
      await this.msg.markClassSeen(me.uid, this.selectedClassId);
    } catch (e: any) {
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
