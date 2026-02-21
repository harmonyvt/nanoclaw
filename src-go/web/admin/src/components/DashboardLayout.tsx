import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  ClipboardList,
  Box,
  Users,
  Zap,
  Settings,
  Menu,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const navigation = [
  { name: 'Overview', href: '/', icon: LayoutDashboard },
  { name: 'Tasks', href: '/tasks', icon: ClipboardList },
  { name: 'Sandboxes', href: '/sandboxes', icon: Box },
  { name: 'Sessions', href: '/sessions', icon: Users },
  { name: 'Events', href: '/events', icon: Zap },
];

function Sidebar() {
  const location = useLocation();

  return (
    <div className="flex h-full flex-col border-r bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <span className="font-semibold">NanoClaw Admin</span>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {navigation.map((item) => {
          const isActive = location.pathname === item.href;
          return (
            <NavLink
              key={item.name}
              to={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </NavLink>
          );
        })}
      </nav>
      <div className="border-t p-4">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3"
          size="sm"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Button>
      </div>
    </div>
  );
}

function MobileSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-0">
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center justify-between border-b px-4">
            <span className="font-semibold">NanoClaw Admin</span>
          </div>
          <nav className="flex-1 space-y-1 p-4">
            {navigation.map((item) => (
              <NavLink
                key={item.name}
                to={item.href}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </NavLink>
            ))}
          </nav>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function DashboardLayout() {
  return (
    <div className="flex h-screen bg-background">
      {/* Desktop Sidebar */}
      <div className="hidden md:block w-64">
        <Sidebar />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-14 items-center gap-4 border-b bg-background px-4 lg:px-6">
          <MobileSidebar />
          <div className="flex-1" />
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
