import bcrypt from 'bcryptjs'

const SALT_ROUNDS = 12

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(String(plain), SALT_ROUNDS)

export const comparePassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(String(plain), String(hash))

export default { hashPassword, comparePassword }
