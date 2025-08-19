import { Component, OnDestroy, OnInit } from '@angular/core';
import { Observable, of, combineLatest, Subscription } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
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

  // compose
  newMessage = '';
  selectedClassId = '';
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

    // build title map
    const titleMap$ = this.myIndex$.pipe(
      map((list) =>
        Object.fromEntries(list.map((x) => [x.classId, x.title || x.classId]))
      )
    );

    // merged messages
    this.messages$ = combineLatest([this.classIds$, titleMap$]).pipe(
      switchMap(([ids, titles]) =>
        ids.length ? this.msg.messagesAcrossClasses$(ids, 40) : of([])
      ),
      map((arr) =>
        arr.map((m) => ({ ...m, classTitle: (m as any).classTitle } as any))
      ) // placeholder
    );

    // enrich with titles and readable dates
    this.messages$ = combineLatest([this.messages$, titleMap$]).pipe(
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

    // mark all seen on enter
    this.sub = combineLatest([this.me$, this.classIds$]).subscribe(
      async ([me, ids]) => {
        if (me?.uid && ids.length) {
          await this.msg.markAllSeen(me.uid, ids);
        }
      }
    );
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  async send() {
    const me = await this.auth.user$.pipe().toPromise();
    if (!me?.uid) return;
    if (!this.selectedClassId) {
      alert('Sélectionnez une classe pour publier.');
      return;
    }
    if (!this.newMessage.trim()) return;
    await this.msg.sendMessage(this.selectedClassId, this.newMessage);
    this.newMessage = '';
    await this.msg.markClassSeen(me.uid, this.selectedClassId);
  }
}

interface ClassMessageWithMeta extends ClassMessage {
  classTitle: string;
  createdAtDate: Date;
}
