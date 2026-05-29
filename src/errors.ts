export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PolicyViolationError"
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}
