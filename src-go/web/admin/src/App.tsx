import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DashboardLayout } from '@/components/DashboardLayout';
import { OverviewPage } from '@/pages/OverviewPage';
import { TasksPage } from '@/pages/TasksPage';
import { SandboxesPage } from '@/pages/SandboxesPage';
import { SessionsPage } from '@/pages/SessionsPage';
import { EventsPage } from '@/pages/EventsPage';

function App() {
  return (
    <TooltipProvider>
      <BrowserRouter basename="/admin">
        <Routes>
          <Route path="/" element={<DashboardLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="sandboxes" element={<SandboxesPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="events" element={<EventsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  );
}

export default App;
