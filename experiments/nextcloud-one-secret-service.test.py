import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("nextcloud_one_secret", Path(__file__).with_name("nextcloud-one-secret-service.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SelectionTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="orbit-nextcloud-selection-", dir="/var/tmp")
        directory = Path(self.root.name) / "nextcloud-config"
        directory.mkdir(mode=0o700)
        self.path = directory / "nextcloud.cfg"
        self.fixture = "[Accounts]\nversion=2\n0\\authType=webflow\n0\\url=https://fixture.invalid\n0\\webflow_user=fixture-user\n"
        self.path.write_text(self.fixture)

    def tearDown(self):
        self.root.cleanup()

    def test_selects_only_current_account_password(self):
        self.assertEqual(module.selected_attributes(self.path), {
            "server": "Nextcloud", "user": "fixture-user:https://fixture.invalid/:0", "type": "plaintext"})

    def test_multiple_accounts_are_rejected(self):
        self.path.write_text(self.fixture + "1\\authType=webflow\n1\\url=https://other.invalid\n1\\webflow_user=other\n")
        with self.assertRaises(ValueError):
            module.selected_attributes(self.path)

    def test_symlink_is_rejected(self):
        original = self.path.with_name("original.cfg")
        self.path.rename(original)
        self.path.symlink_to(original)
        with self.assertRaises(OSError):
            module.selected_attributes(self.path)

    def test_encoded_or_wrong_auth_fields_are_rejected(self):
        for fixture in (self.fixture.replace("fixture-user", '"fixture-user"'), self.fixture.replace("=webflow", "=http")):
            self.path.write_text(fixture)
            with self.assertRaises(ValueError):
                module.selected_attributes(self.path)


if __name__ == "__main__":
    unittest.main()
