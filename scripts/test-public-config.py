import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("check-public-config.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class Guard(unittest.TestCase):
    def test_rejects_private_values_without_echoing_them(self):
        cases = ["https://worker." + "tail12345.ts.net", ".".join(["100", "90", "1", "2"]), "-----BEGIN " + "OPENSSH PRIVATE KEY-----"]
        for value in cases:
            self.assertTrue(guard.violations([value]))
            self.assertNotIn(value, str(guard.violations([value])))
    def test_allows_placeholders_and_documentation_domains(self):
        self.assertEqual(guard.violations(["${PAPERCLIP_PUBLIC_URL}", "https://example.invalid/v1", "127.0.0.1:3100"]), [])
    def test_skips_only_published_exception_commits(self):
        value = ".".join(["100", "90", "1", "2"])
        log = "\n".join(["\0commit published", "+++ b/a", "+" + value, "\0commit fresh", "+++ b/b", "+ok", "-" + value])
        self.assertEqual(guard.added_lines(log, frozenset({"published"})), ["ok"])
        self.assertEqual(guard.added_lines(log, frozenset()), [value, "ok"])
        self.assertTrue(guard.violations(guard.added_lines(log.replace("published", "other"), frozenset({"published"}))))

if __name__ == "__main__":
    unittest.main()
