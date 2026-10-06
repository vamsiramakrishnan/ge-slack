"""The renderer refuses settings that would break residency or inject YAML (CI: unittest)."""
import os
import unittest

from render import render

TEMPLATE = open(os.path.join(os.path.dirname(__file__), "service.yaml"), encoding="utf8").read()
BASE = {
    "SERVICE": "ge-slack", "IMAGE": "europe-west1-docker.pkg.dev/p/ge-slack/ge-slack:abc",
    "RUNTIME_SA": "rt@p.iam.gserviceaccount.com", "CRON_INVOKER": "cron@p.iam.gserviceaccount.com",
    "MAX_INSTANCES": "10", "REGION": "europe-west1", "SLACK_TEAM_ID": "T1",
    "SLACK_TEAM_DOMAIN": "acme", "PUBLIC_BASE_URL": "https://ge.example", "GE_PROJECT": "p",
    "GE_LOCATION": "eu", "GE_ENGINE": "e", "IDP_KIND": "google",
    "IDP_ISSUER": "https://accounts.google.com", "IDP_CLIENT_ID": "c", "GE_SLACK_KMS_KEY": "k",
    "SOURCES_VERSION": "latest", "AGENTS_VERSION": "4",
}


def refused(**over):
    with self_raises() as ctx:
        render(TEMPLATE, {**BASE, **over})
    return str(ctx.exception)


class self_raises:  # tiny helper so refusals read as one line in the tests
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, _tb):
        self.exception = exc
        if exc_type is not SystemExit:
            raise AssertionError(f"expected a refusal, got {exc_type}")
        return True


class RenderTest(unittest.TestCase):
    def test_renders_and_drops_empty_optionals(self):
        out = render(TEMPLATE, BASE)
        self.assertIn('value: "cron@p.iam.gserviceaccount.com"', out)
        self.assertNotIn("WIF_POOL_ID", out)
        self.assertNotIn("${", out)
        self.assertIn("key: '4'", out)

    def test_values_are_quoted_and_never_expanded_twice(self):
        out = render(TEMPLATE, {**BASE, "IDP_ISSUER": "https://x/${SERVICE}: #y"})
        self.assertIn('value: "https://x/${SERVICE}: #y"', out)

    def test_residency(self):
        self.assertIn("outside the GE_LOCATION=eu residency", refused(REGION="us-central1"))
        self.assertIn("ALLOW_GLOBAL_REGION", refused(GE_LOCATION="global"))
        render(TEMPLATE, {**BASE, "GE_LOCATION": "global", "ALLOW_GLOBAL_REGION": "1"})

    def test_injection_and_required_settings(self):
        self.assertIn("control characters", refused(SERVICE="x\n  evil: 1"))
        self.assertIn("RUNTIME_SA", refused(RUNTIME_SA="a@b.iam.gserviceaccount.com' x"))
        self.assertIn("WIF_POOL_ID", refused(IDP_KIND="oidc"))
        self.assertIn("GE_SERVICE_ACCOUNT", refused(GE_SERVICE_MODE="impersonate"))
        self.assertIn("https", refused(PUBLIC_BASE_URL="http://ge.example"))


if __name__ == "__main__":
    unittest.main()
