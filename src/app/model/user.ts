// models.ts

// Reuse your existing User class
export class User {
  uid?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  photoURL?: string;
  emailLower?: string;
  schoolId?: string;
  platformRole?: 'user' | 'instructor' | 'admin'; // optional, lightweight
}

// --- Common types/enums ---
export type Role = 'student' | 'instructor' | 'ta';
export type LessonType = 'video' | 'pdf' | 'link' | 'quiz';
export type ClassStatus = 'active' | 'archived';

// If you prefer stricter typing for Firestore dates, change `any` to:
// Date | firebase.firestore.Timestamp  (when using compat)
type FSDate = any;

// --- Optional multi-tenant org/school ---
export interface School {
  id?: string;
  name: string;
  ownerId: string;
  status?: 'active' | 'suspended';
  createdAt?: FSDate;
  updatedAt?: FSDate;
}

export interface CourseDoc {
  id?: string;
  title: string;
  description?: string;
}
export interface CourseModule {
  id?: string;
  title: string;
  order: number;
  durationMin?: number;
}

// --- Course content (reusable across classes) ---
export interface Course {
  id?: string;
  title: string;
  description?: string;
  ownerId: string;
  schoolId?: string;
  published: boolean;
  contentVersion: number; // bump when content changes
  modulesCount: number;
  lessonsCount: number;
  createdAt?: FSDate;
  updatedAt?: FSDate;
}

export interface Module {
  id?: string;
  courseId?: string; // handy when you flatten queries
  title: string;
  order: number; // sort key
  summary?: string;
}

export interface Lesson {
  id?: string;
  courseId?: string;
  moduleId?: string;
  title: string;
  order: number;
  type: LessonType; // 'video' | 'pdf' | 'link' | 'quiz'
  storagePath?: string; // Firebase Storage path
  durationSec?: number;
  isPreview?: boolean; // allow unauthenticated preview if needed
}

// --- Running instance (class/section) ---
export interface ClassSection {
  id?: string;
  courseId: string;
  contentVersion: number; // lock to course version when created
  instructorId: string;
  schoolId?: string;
  title: string; // e.g., "Intro to Microfinance (Fall 2025)"
  schedule?: { startAt?: FSDate; endAt?: FSDate };
  status: ClassStatus; // 'active' | 'archived'
  counts?: { students: number; instructors: number };
  createdAt?: FSDate;
  updatedAt?: FSDate;
}

// Per-class membership / roles
export interface ClassMember {
  uid: string;
  role: Role; // 'student' | 'instructor' | 'ta'
  status: 'active' | 'dropped';
  enrolledAt?: FSDate;
}

// --- Class communications ---
export interface Announcement {
  id?: string;
  title: string;
  body: string;
  postedBy: string; // uid
  postedAt?: FSDate;
}

// --- Assignments & submissions ---
export interface Assignment {
  id?: string;
  classId?: string;
  title: string;
  instructions?: string;
  dueAt?: FSDate;
  points?: number; // e.g., 100
  moduleRef?: { moduleId: string; lessonId?: string }; // optional linkage to content
  createdBy: string; // uid
  createdAt?: FSDate;
}

export interface SubmissionFile {
  name: string;
  storagePath: string; // Firebase Storage path
  sizeBytes?: number;
  contentType?: string;
}

export interface Submission {
  id?: string;
  uid: string; // student uid
  submittedAt?: FSDate;
  files: SubmissionFile[];
  score?: number;
  gradedAt?: FSDate;
  gradedBy?: string; // instructor/ta uid
  feedback?: string;
}

// --- Optional: user-side index to power dashboards quickly ---
export interface UserClassIndex {
  classId: string;
  role: Role;
  status: 'active' | 'dropped';
  title?: string; // class title snapshot
  updatedAt?: FSDate;
}

export type QuizQuestionKind = 'mcq-single' | 'mcq-multi' | 'text';
// --- Quiz bits ---
export interface QuizQuestion {
  id: string; // unique within the pool
  prompt: string;
  choices?: string[]; // 4 options typical
  correctIndex?: number; // 0..choices.length-1
  kind?: QuizQuestionKind;
  // MCQ props
  correct?: number; // for mcq-single
  correctMulti?: number[]; // for mcq-multi
  // Text props
  correctText?: string; // for text exact match
}

export interface QuizAssignment extends Assignment {
  type: 'quiz';
  numQuestions: number; // e.g., 5
  pool: QuizQuestion[]; // question bank for this assignment
}

export interface QuizAttempt {
  id?: string;
  uid: string; // student
  selectedIds: string[]; // the 5 question IDs chosen for this user
  answers: number[]; // -1 for unanswered, else 0..3
  submittedAt?: FSDate;
  score?: number; // 0..numQuestions
  gradedAt?: FSDate;
}
