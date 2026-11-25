import type { Type } from '@angular/core';

export interface ModuleDef {
  path: string;
  label: string;
  icon: string;
  group: 'Library' | 'Create' | 'Communicate' | 'Media' | 'Tools';
  load: () => Promise<Type<unknown>>;
}

/** Single source of truth for navigation and lazy routes. Add a module here and nowhere else. */
export const MODULES: ModuleDef[] = [
  {
    path: 'files',
    label: 'Files',
    icon: '📁',
    group: 'Library',
    load: () => import('./features/files/files').then((m) => m.Files),
  },
  {
    path: 'pdf',
    label: 'PDF Editor',
    icon: '📄',
    group: 'Create',
    load: () => import('./features/pdf/pdf-editor').then((m) => m.PdfEditor),
  },
  {
    path: 'image-editor',
    label: 'Image Editor',
    icon: '🎨',
    group: 'Create',
    load: () => import('./features/image/image-editor').then((m) => m.ImageEditor),
  },
  {
    path: 'video-editor',
    label: 'Video Editor',
    icon: '✂️',
    group: 'Create',
    load: () => import('./features/video/video-editor').then((m) => m.VideoEditor),
  },
  {
    path: 'websites',
    label: 'Website Editor',
    icon: '🌐',
    group: 'Create',
    load: () => import('./features/website/website').then((m) => m.Website),
  },
  {
    path: 'chat',
    label: 'Chat',
    icon: '💬',
    group: 'Communicate',
    load: () => import('./features/chat/chat').then((m) => m.Chat),
  },
  {
    path: 'text-chats',
    label: 'Text Chat',
    icon: '🗨️',
    group: 'Communicate',
    load: () => import('./features/text-chats/text-chats').then((m) => m.TextChats),
  },
  {
    path: 'notes',
    label: 'Notes',
    icon: '📝',
    group: 'Communicate',
    load: () => import('./features/notes/notes').then((m) => m.Notes),
  },
  {
    path: 'tasks',
    label: 'Tasks',
    icon: '✅',
    group: 'Communicate',
    load: () => import('./features/tasks/tasks').then((m) => m.Tasks),
  },
  {
    path: 'movies',
    label: 'Movies',
    icon: '🎞️',
    group: 'Media',
    load: () => import('./features/movies/movies').then((m) => m.Movies),
  },
  {
    path: 'slideshows',
    label: 'Slideshows',
    icon: '🖼️',
    group: 'Media',
    load: () => import('./features/movies/slideshows').then((m) => m.Slideshows),
  },
  {
    path: 'books',
    label: 'Books',
    icon: '📚',
    group: 'Media',
    load: () => import('./features/books/books').then((m) => m.Books),
  },
  {
    path: 'bills',
    label: 'Bills',
    icon: '🧾',
    group: 'Tools',
    load: () => import('./features/bills/bills').then((m) => m.Bills),
  },
  {
    path: 'api-tester',
    label: 'API Tester',
    icon: '🔌',
    group: 'Tools',
    load: () => import('./features/api/api-tester').then((m) => m.ApiTester),
  },
  {
    path: 'custom-apis',
    label: 'Custom APIs',
    icon: '🧩',
    group: 'Tools',
    load: () => import('./features/api/custom-apis').then((m) => m.CustomApis),
  },
  {
    path: 'reports',
    label: 'Reports',
    icon: '📊',
    group: 'Tools',
    load: () => import('./features/reports/reports').then((m) => m.Reports),
  },
];
