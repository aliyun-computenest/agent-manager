import { useAuth } from '../contexts/AuthContext'

export function useApi() {
  const { session } = useAuth()
  
  const getToken = () => session?.access_token || null
  
  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const token = getToken()
    if (!token) throw new Error('Not authenticated')
    
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      }
    })
  }
  
  return { getToken, fetchWithAuth, session }
}
