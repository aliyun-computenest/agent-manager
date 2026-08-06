/**
 * Authentication Middleware
 * Handles user authentication and authorization
 */

import { supabaseAdmin, createUserClient } from '../config/index.js'

async function loadUserProfile(userId) {
  const { data: profile, error } = await supabaseAdmin
    .from('principal_profiles')
    .select('*')
    .eq('id', userId)
    .eq('principal_type', 'user')
    .maybeSingle()

  if (error || !profile) return null
  return {
    ...profile,
    username: profile.name,
    principal_id: profile.id,
    principal_type: profile.principal_type || 'user'
  }
}

async function authenticateToken(token) {
  if (!token) return null

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) return null

  return {
    user,
    userProfile: await loadUserProfile(user.id)
  }
}

/**
 * Auth middleware - verify admin role
 */
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authorization header required' 
      })
    }
    
    const token = authHeader.substring(7)
    const auth = await authenticateToken(token)
    if (!auth) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      })
    }
    
    // Check if user is admin from principal_profiles
    const profile = auth.userProfile
    
    if (!profile) {
      return res.status(401).json({ 
        success: false, 
        error: 'User profile not found' 
      })
    }
    
    if (profile.role !== 'admin' || (profile.status && profile.status !== 'active')) {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin access required' 
      })
    }
    
    // Attach user info to request
    req.user = auth.user
    req.userProfile = profile
    next()
    
  } catch (error) {
    console.error('Auth error:', error)
    return res.status(500).json({ 
      success: false, 
      error: 'Authentication failed' 
    })
  }
}

/**
 * Auth middleware - verify user is authenticated
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authorization header required' 
      })
    }
    
    const token = authHeader.substring(7)
    const auth = await authenticateToken(token)
    if (!auth) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      })
    }

    req.user = auth.user
    req.userProfile = auth.userProfile
    req.userToken = token
    req.supabase = createUserClient(token)
    
    next()
    
  } catch (error) {
    console.error('Auth error:', error)
    return res.status(500).json({ 
      success: false, 
      error: 'Authentication failed' 
    })
  }
}

export {
  authenticateToken,
  requireAdmin,
  requireAuth
}
