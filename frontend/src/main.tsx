import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider, useNavigate, useParams } from 'react-router-dom'
import './index.css'
import { api } from './lib/api'
import { ToastProvider } from './lib/toast'
import { AuthProvider, RequireAuth, RequireSuperAdmin } from './lib/auth'
import Login from './pages/Login'
import Users from './pages/Users'
import Account from './pages/Account'
import Tracker from './pages/Tracker'
import { ErrorPage } from './components/ErrorPage'
import ClientLayout from './pages/client/ClientLayout'
import ClientHome from './pages/client/ClientHome'
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

// Login → client tracker → add client (details · master · societies) → client home → one workspace per society.
const router = createBrowserRouter([{ errorElement: <ErrorPage />, children: [
  { path: '/login', element: <Login /> },
  { element: <RequireAuth />, children: [
    { path: '/', element: <Tracker /> },
    { path: '/clients/new', element: <NewClient /> },
    {
      path: '/clients/:clientId',
      element: <ClientLayout />,
      children: [
        { index: true, element: <ClientHome /> },
        { path: 'societies/:society', element: <SocietyWorkspace /> },
        { path: 'tasks', element: <Tasks /> },
        { path: 'catalogue', element: <Catalogue /> },
        { path: 'works/:workId', element: <WorkPage /> },
      ],
    },
    { path: '/account', element: <Account /> },
    { element: <RequireSuperAdmin />, children: [{ path: '/users', element: <Users /> }] },
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
