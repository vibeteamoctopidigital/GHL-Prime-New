import { z } from 'zod'
import { UserRole } from '../../config/constants.js'

const emailSchema = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')

const passwordSchema = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    fullName: z.string().trim().min(1).optional(),
    full_name: z.string().trim().min(1).optional(),
    role: z.nativeEnum(UserRole).optional(),
  })
  .transform(({ full_name: snakeName, fullName, ...rest }) => ({
    ...rest,
    fullName: fullName ?? snakeName,
  }))

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
})

export const refreshSchema = z
  .object({
    refreshToken: z.string().trim().min(1).optional(),
    refresh_token: z.string().trim().min(1).optional(),
  })
  .transform(({ refresh_token: snakeToken, refreshToken }) => ({
    refreshToken: refreshToken ?? snakeToken,
  }))

export const logoutSchema = refreshSchema

export const changePasswordSchema = z.object({
  currentPassword: z.string({ required_error: 'Current password is required' }).min(1, 'Current password is required'),
  newPassword: passwordSchema,
})

export const updateUserSchema = z
  .object({
    role: z.nativeEnum(UserRole).optional(),
    isActive: z.boolean().optional(),
    is_active: z.boolean().optional(),
    fullName: z.string().trim().optional(),
    full_name: z.string().trim().optional(),
  })
  .transform(({ is_active: snakeActive, full_name: snakeName, isActive, fullName, ...rest }) => ({
    ...rest,
    isActive: isActive ?? snakeActive,
    fullName: fullName ?? snakeName,
  }))

export type RegisterBody = z.infer<typeof registerSchema>
export type LoginBody = z.infer<typeof loginSchema>
export type RefreshBody = z.infer<typeof refreshSchema>
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>
export type UpdateUserBody = z.infer<typeof updateUserSchema>
