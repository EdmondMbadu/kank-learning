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
    this.me$ = this.auth.user$;
    this.isAdmin$ = this.auth.user$.pipe(
      map((u) => (u?.platformRole || '').toLowerCase() === 'admin')
    );

    this.myIndex$ = this.auth.user$.pipe(
      switchMap((me) =>
        me?.uid ? this.classes.userClassIndex$(me.uid) : of([])
      )
    );

    this.classIds$ = this.myIndex$.pipe(
      map((list) => list.map((x) => x.classId))
    );

    // Auto-select the first class if none is chosen yet
    this.sub = this.myIndex$.subscribe((idx) => {
      if (!this.selectedClassId && idx?.length)
        this.selectedClassId = idx[0].classId;
    });

    // title map
    const titleMap$ = this.myIndex$.pipe(
      map((list) =>
        Object.fromEntries(list.map((x) => [x.classId, x.title || x.classId]))
      )
    );

    // 1) raw merged feed (no meta yet)
    this.messagesRaw$ = this.classIds$.pipe(
      switchMap((ids) =>
        ids.length ? this.msg.messagesAcrossClasses$(ids, 40) : of([])
      )
    );

    // 2) enrich with titles + dates => final typed stream
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

    // enrich

    // mark all seen on enter
    this.sub.add(
      combineLatest([this.me$, this.classIds$]).subscribe(async ([me, ids]) => {
        if (me?.uid && ids.length) await this.msg.markAllSeen(me.uid, ids);
      })
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
      const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
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
