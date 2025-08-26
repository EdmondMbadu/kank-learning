import { Component } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import { BehaviorSubject, Observable, of, combineLatest } from 'rxjs';
import { filter, map, shareReplay, startWith, switchMap } from 'rxjs/operators';
import { ClassSection, Lesson } from 'src/app/model/user';
import { ClassService } from 'src/app/shared/class.service';

type DayGroup = { key: string; label: string; items: Lesson[] };
type Kind = 'pdf' | 'image' | 'link' | 'video' | 'quiz' | 'file';

@Component({
  selector: 'app-class-readings',
  templateUrl: './class-readings.component.html',
  styleUrls: [], // Tailwind-only
})
export class ClassReadingsComponent {
  // route param
  classId$ = this.route.paramMap.pipe(map((p) => p.get('id')!));

  // class doc (title/cover)
  class$: Observable<ClassSection> = this.classId$.pipe(
    switchMap((id) => this.classes.class$(id)),
    filter((c): c is ClassSection => !!c),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // search + kind filter
  private q$ = new BehaviorSubject<string>('');
  setQuery(v: string) {
    this.q$.next(v || '');
  }

  kindOptions: Kind[] = ['pdf', 'image', 'link'];
  private kindFilter$ = new BehaviorSubject<Kind[]>([]);
  isKindActive(k: Kind) {
    return this.kindFilter$.value.includes(k);
  }
  toggleKind(k: Kind) {
    const curr = this.kindFilter$.value.slice();
    const i = curr.indexOf(k);
    if (i >= 0) curr.splice(i, 1);
    else curr.push(k);
    this.kindFilter$.next(curr);
  }
  clearFilters() {
    this.kindFilter$.next([]);
    this.q$.next('');
  }

  // lessons (latest first)
  lessons$: Observable<Lesson[]> = this.classId$.pipe(
    switchMap((classId) =>
      classId
        ? this.afs
            .collection<Lesson>(`classes/${classId}/lessons`)
            .valueChanges({ idField: 'id' })
        : of([] as Lesson[])
    ),
    map((list) =>
      [...(list || [])].sort(
        (a, b) =>
          this.ms(b.createdAt) - this.ms(a.createdAt) ||
          (b.order ?? 0) - (a.order ?? 0)
      )
    ),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // filtered by search + kinds
  filtered$: Observable<Lesson[]> = combineLatest([
    this.lessons$,
    this.q$.pipe(startWith('')),
    this.kindFilter$.pipe(startWith([] as Kind[])),
  ]).pipe(
    map(([list, q, kinds]) => {
      const t = (q || '').trim().toLowerCase();
      return (list || []).filter((l) => {
        const matchesText =
          !t ||
          (l.title || '').toLowerCase().includes(t) ||
          (l.contentType || '').toLowerCase().includes(t);
        const k = this.kindOf(l);
        const matchesKind = !kinds.length || kinds.includes(k);
        return matchesText && matchesKind;
      });
    })
  );

  // grouped by day (for compact headers)
  groups$: Observable<DayGroup[]> = this.filtered$.pipe(
    map((list) => this.groupByDay(list || []))
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private afs: AngularFirestore,
    private classes: ClassService
  ) {}

  // navigation + actions
  back(classId: string) {
    this.router.navigate(['/class', classId]);
  }
  open(l: Lesson) {
    const url = (l as any)?.url;
    if (url) window.open(url, '_blank', 'noopener');
  }

  // Kind detection + icon
  kindOf(l: Lesson): Kind {
    const ct = (l as any)?.contentType?.toLowerCase?.() || '';
    if (l.type === 'pdf' || ct === 'application/pdf') return 'pdf';
    if (ct.startsWith('image/')) return 'image';
    if (l.type === 'video' || ct.startsWith('video/')) return 'video';
    if (l.type === 'quiz') return 'quiz';
    if (l.type === 'link' || (l as any)?.url?.startsWith('http')) return 'link';
    return 'file';
  }
  iconPath(k: Kind): string {
    switch (k) {
      case 'pdf':
        return 'M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1v4h4';
      case 'image':
        return 'M4 5h16v14H4z M8 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12 6-5-6-4 5-2-2-5 7h16';
      case 'link':
        return 'M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 0 1 7 7L17 12m-6 6a5 5 0 0 0 7 0L20 16m-8-4 4-4';
      case 'video':
        return 'M4 6h12v12H4z M16 10l4-2v8l-4-2';
      case 'quiz':
        return 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 13h0.01M9 9a3 3 0 1 1 6 0c0 2-3 2-3 4';
      default:
        return 'M6 4h12v16H6z M8 6h8v2H8z M8 10h8v2H8z M8 14h8v2H8z';
    }
  }

  // trackBy helpers
  trackById(_i: number, x: { id?: string }) {
    return x?.id ?? _i;
  }
  trackByKey(_i: number, g: DayGroup) {
    return g.key;
  }

  // utils
  private ms(x: any): number {
    if (!x) return 0;
    if (x instanceof Date) return x.getTime();
    const t = (x as any)?.toDate?.();
    return t instanceof Date ? t.getTime() : typeof x === 'number' ? x : 0;
  }
  private groupByDay(list: Lesson[]): DayGroup[] {
    const keyOf = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d
        .getDate()
        .toString()
        .padStart(2, '0')}`;
    const labelOf = (d: Date) =>
      d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

    const by: Record<string, Lesson[]> = {};
    for (const l of list) {
      const d = new Date(this.ms(l.createdAt));
      const k = keyOf(d);
      (by[k] ||= []).push(l);
    }
    return Object.entries(by)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest day first
      .map(([key, items]) => ({ key, label: labelOf(new Date(key)), items }));
  }
}
