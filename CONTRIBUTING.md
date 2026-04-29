# Contributing to ioBroker.alphainnotec

Thanks for your interest in contributing! Here's how you can help:

## Issues

Found a bug or have a feature request? Please:

1. **Check existing issues** first to avoid duplicates
2. **Provide details**:
   - Your Luxtronik hardware model and firmware version
   - ioBroker version and adapter version
   - Exact error message or unexpected behavior
   - Steps to reproduce (if applicable)

## Development Setup

```bash
git clone https://github.com/ioBroker/ioBroker.alphainnotec.git
cd ioBroker.alphainnotec
npm install
npm run build
```

## Making Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Build: `npm run build`
4. Test on your Luxtronik setup
5. Commit with clear messages: `git commit -m "Fix: description"`
6. Push and create a Pull Request

## Code Style

- Use TypeScript strictly
- Follow existing code patterns
- Add comments for complex logic
- Keep logging statements minimal (avoid spam)

## Pull Request Process

1. Update [CHANGELOG.md](CHANGELOG.md) with your changes
2. Update [README.md](README.md) if you changed configuration or features
3. Ensure `npm run build` passes
4. Link any related issues

## Testing

Please test on actual Luxtronik hardware if possible:

```bash
npm install ./iobroker.alphainnotec-1.0.8.tgz --force
iobroker upload alphainnotec
iobroker restart alphainnotec.0
iobroker logs alphainnotec.0 --lines 50
```

Verify that states are created and populated with correct values.

## Questions?

Open an issue with the label `question` or `discussion`.

---

Thank you for contributing! 🚀
