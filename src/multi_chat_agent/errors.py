"""Public diagnostics whose codes never contain prompts or response bodies."""


class AgentError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
