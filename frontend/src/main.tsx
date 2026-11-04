import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider, useNavigate, useParams } from 'react-router-dom'
import './index.css'
import { api } from './lib/api'
import { ToastProvider } from './lib/toast'
import { AuthProvider, RequireAuth, RequireAdmin } from './lib/auth'
import Login from './pages/Login'
import Users from './pages/Users'
import Account from './pages/Account'
import Tracker from './pages/Tracker'
import { ErrorPage } from './components/ErrorPage'
import ClientLayout from './pages/client/ClientLayout'
import ClientHome from './pages/client/ClientHome'
import Consolidate from './pages/client/Consolidate'
import SocietyWorkspace from './pages/client/SocietyWorkspace'
import NewClient from './pages/NewClient'
import Tasks from './pages/client/Tasks'
import Catalogue from './pages/client/Catalogue'
import WorkPage from './pages/client/WorkPage'

/** Old /runs/:id links open that report inside its client. */
function RunRedirect() {
  const { runId } = useParams()
  const navigate = useNavigate()
  useEffect(() => {
    api.run(Number(runId)).then((p) => navigate(p.run.client ? `/clients/${p.run.client.id}/societies/${p.run.society}?report=${runId}` : '/', { replace: true }))
      .catch(() => navigate('/', { replace: true }))
  }, [runId, navigate])
  return null
}

// Login → clients → add client (details · the three files) → the client's flow: 1 files · 2 Muso & LNV ·
// 3 LNV vs IPRS · 4 final LNV. Follow-up tasks, the catalogue and the society workspaces ("More tools") sit beside it.
const router = createBrowserRouter([{ errorElement: <ErrorPage />, children: [
  { path: '/login', element: <Login /> },
  { element: <RequireAuth />, children: [
    { path: '/', element: <Tracker /> },
    { path: '/clients/new', element: <NewClient /> },
    {
      path: '/clients/:clientId',
      element: <ClientLayout />,
      children: [
        { index: true, element: <Consolidate /> },
        { path: 'consolidate', element: <Consolidate /> },
        { path: 'tools', element: <ClientHome /> },
        { path: 'check', element: <Navigate to="../consolidate" replace /> },
        { path: 'clean', element: <Navigate to="../consolidate" replace /> },
        { path: 'societies/:society', element: <SocietyWorkspace /> },
        { path: 'tasks', element: <Tasks /> },
        { path: 'catalogue', element: <Catalogue /> },
        { path: 'works/:workId', element: <WorkPage /> },
      ],
    },
    { path: '/account', element: <Account /> },
    { element: <RequireAdmin />, children: [{ path: '/users', element: <Users /> }] },
    { path: '/runs/:runId', element: <RunRedirect /> },
    { path: '*', element: <Navigate to="/" replace /> },
  ] },
] }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
)
