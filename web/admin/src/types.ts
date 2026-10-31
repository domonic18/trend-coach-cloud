export type ContentStatus = 'draft' | 'published' | 'archived'
export type UserRole = 'student' | 'operator' | 'admin'
export type UserStatus = 'active' | 'disabled'

export interface SessionUser {
  userId: string
  username: string
  displayName: string | null
  role: UserRole
}

export interface SessionResponse {
  token: string
  expiresAt: number
  user: SessionUser
}

export interface Course {
  courseId: string
  title: string
  status: ContentStatus
}

export interface CourseSummary extends Course {
  chapterCount: number
  knowledgePointCount: number
  segmentCount: number
  articleCount: number
}

export interface ArticleMeta {
  version: number
  status: ContentStatus
  publishedAt: number | null
}

export interface Article extends ArticleMeta {
  markdown: string
}

export interface KnowledgePoint {
  knowledgePointId: string
  title: string
  position: number
  segmentCount: number
  article: ArticleMeta | null
}

export interface Chapter {
  chapterId: string
  title: string
  position: number
  knowledgePoints: KnowledgePoint[]
}

export interface CourseTree {
  course: Course
  chapters: Chapter[]
}

export interface Segment {
  segmentId: string
  courseId: string
  chapterId: string
  knowledgePointId: string
  title: string
  startSec: number
  endSec: number
  text: string
  status: ContentStatus
  hasEmbedding: boolean
}

export interface SegmentList {
  segments: Segment[]
  total: number
  offset: number
  limit: number
}

export interface User {
  userId: string
  username: string | null
  displayName: string | null
  role: UserRole
  status: UserStatus
  deviceCount: number
  createdAt: number
  lastActiveAt: number | null
}

export interface UserList {
  users: User[]
  total: number
  offset: number
  limit: number
}
