"""Validate the plain KEY=value file without executing it or printing values."""
import pathlib
import re
import sys


def read_env(path):
    values = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in values:
            raise ValueError('Expected unique KEY=value lines without export or spaces around keys')
        if not value or value != value.strip() or value.startswith(('"', "'")):
            raise ValueError(f'{key} must have a nonempty, unquoted value without surrounding spaces')
        values[key] = value
    return values


def validate(candidate, current):
    if candidate.get('NODE_ENV') != 'production' or candidate.get('PORT') != '3000':
        raise ValueError('Staging requires NODE_ENV=production and PORT=3000')
    # Changing a URL is not equivalent to rotating an existing database role.
    for key in ('DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL'):
        if not current.get(key) or candidate.get(key) != current[key]:
            raise ValueError(f'{key} changed; infrastructure/credential rotation requires a separate coordinated operation')
    allowed = set(current)
    if set(candidate) - allowed:
        raise ValueError('Unknown environment keys; update the deployment validator for new application settings')


if __name__ == '__main__':
    try:
        validate(read_env(sys.argv[1]), read_env(sys.argv[2]))
    except (ValueError, OSError) as error:
        print(f'Environment validation failed: {error}', file=sys.stderr)
        sys.exit(1)
    print('Staging environment structure validated')
