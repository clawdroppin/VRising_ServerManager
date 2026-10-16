import { Activity, Archive, CalendarClock, Crown, FileCode2, Globe2, HardDrive, LayoutDashboard, Rocket, Router, ShieldCheck, SlidersHorizontal, Swords, Terminal, Users } from 'lucide-react';
import type { ViewId } from '@/store/app';

export const VIEWS: { id: ViewId; label: string; icon: typeof Activity; group: 'Monitor' | 'World' | 'Configure' | 'Maintain' }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Monitor' },
  { id: 'performance', label: 'Performance', icon: Activity, group: 'Monitor' },
  { id: 'console', label: 'Console', icon: Terminal, group: 'Monitor' },
  { id: 'players', label: 'Players', icon: Users, group: 'Monitor' },
  { id: 'worlds', label: 'Worlds', icon: Globe2, group: 'World' },
  { id: 'backups', label: 'Backups', icon: Archive, group: 'World' },
  { id: 'settings', label: 'Server Settings', icon: SlidersHorizontal, group: 'Configure' },
  { id: 'gameplay', label: 'Game Rules', icon: Swords, group: 'Configure' },
  { id: 'access', label: 'Admins & Bans', icon: Crown, group: 'Configure' },
  { id: 'automation', label: 'Automation', icon: CalendarClock, group: 'Configure' },
  { id: 'launch', label: 'Process & Launch', icon: Rocket, group: 'Configure' },
  { id: 'config', label: 'Config Files', icon: FileCode2, group: 'Configure' },
  { id: 'ports', label: 'Port Forwarding', icon: Router, group: 'Maintain' },
  { id: 'health', label: 'Network & Health', icon: ShieldCheck, group: 'Maintain' },
  { id: 'files', label: 'Install & Files', icon: HardDrive, group: 'Maintain' },
];
