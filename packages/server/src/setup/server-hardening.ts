import { createWriteStream } from "node:fs";
import {
	createServerDeployment,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { runSshCommand } from "./ssh-command";
import { TRAEFIK_HTTP3_PORT, TRAEFIK_SSL_PORT } from "./traefik-setup";

export const SERVER_HARDENING_ITEMS = ["ufw", "ssh", "fail2ban"] as const;

export type ServerHardeningItem = (typeof SERVER_HARDENING_ITEMS)[number];

export type ServerHardening = Record<ServerHardeningItem, boolean>;

export const SERVER_HARDENING_DONE = "Security hardening finished ✅";
export const SERVER_HARDENING_FAILED = "Security hardening failed ❌";

export const getServerHardening = (): ServerHardening => {
	const requested = (process.env.DOKPLOY_SERVER_HARDENING ?? "")
		.split(",")
		.map((item) => item.trim().toLowerCase());
	const all = requested.includes("all");

	return {
		ssh: all || requested.includes("ssh"),
		ufw: all || requested.includes("ufw"),
		fail2ban: all || requested.includes("fail2ban"),
	};
};

// A fresh VPS often runs unattended-upgrades right after boot, so apt waits for
// its lock instead of failing on the first try.
const aptInstall = (packageName: string) =>
	`$SUDO_CMD env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq ${packageName} >/dev/null`;

// The Security tab reads the main sshd_config, not drop-ins, so the options are
// written there. They go on the first line because sshd keeps the first value it reads.
export const hardenSshCommand = () => `
	if [ -f /etc/ssh/sshd_config ]; then
		echo "SSH: allowing key login only"
		if [ ! -f /etc/ssh/sshd_config.dokploy-backup ]; then
			$SUDO_CMD cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.dokploy-backup
		fi
		for option in "PubkeyAuthentication yes" "PasswordAuthentication no" "KbdInteractiveAuthentication no" "PermitRootLogin prohibit-password" "UsePAM no"; do
			key=$(echo "$option" | awk '{print $1}')
			$SUDO_CMD sed -i -E "/^[#[:space:]]*$key[[:space:]]/Id" /etc/ssh/sshd_config
			$SUDO_CMD sed -i "1i $option" /etc/ssh/sshd_config
		done
		if ! $SUDO_CMD sshd -t; then
			$SUDO_CMD cp -p /etc/ssh/sshd_config.dokploy-backup /etc/ssh/sshd_config
			echo "sshd rejected the hardened config, the original was restored ❌" >&2
			exit 1
		fi
		$SUDO_CMD systemctl reload ssh 2>/dev/null || $SUDO_CMD systemctl reload sshd
		echo "SSH allows keys only ✅"
	else
		echo "SSH: /etc/ssh/sshd_config not found, skipped."
	fi
`;

// ufw drops forwarded traffic by default, which breaks container networking,
// so forwarding is accepted while incoming traffic to the host stays denied.
export const hardenUfwCommand = () => `
	if [ "$OS_TYPE" = "ubuntu" ] || [ "$OS_TYPE" = "debian" ] || [ "$OS_TYPE" = "raspbian" ]; then
		echo "UFW: installing and allowing SSH and ${TRAEFIK_SSL_PORT} only"
		${aptInstall("ufw")}
		SSH_PORT=$($SUDO_CMD sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }') || true
		if [ -z "$SSH_PORT" ]; then
			SSH_PORT=22
		fi
		$SUDO_CMD ufw default deny incoming >/dev/null
		$SUDO_CMD ufw default allow outgoing >/dev/null
		$SUDO_CMD sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
		$SUDO_CMD ufw allow "$SSH_PORT/tcp" comment 'SSH' >/dev/null
		$SUDO_CMD ufw allow ${TRAEFIK_SSL_PORT}/tcp comment 'HTTPS' >/dev/null
		$SUDO_CMD ufw allow ${TRAEFIK_HTTP3_PORT}/udp comment 'HTTP/3' >/dev/null
		$SUDO_CMD ufw --force enable >/dev/null
		echo "UFW is active ✅ (open: $SSH_PORT/tcp, ${TRAEFIK_SSL_PORT}/tcp, ${TRAEFIK_HTTP3_PORT}/udp)"
	else
		echo "UFW hardening supports Debian and Ubuntu only, skipped."
	fi
`;

// The Security tab only reads the [sshd] section of /etc/fail2ban/jail.local,
// so the jail goes there. An existing [sshd] section is the owner's choice and stays.
export const hardenFail2banCommand = () => `
	if [ "$OS_TYPE" = "ubuntu" ] || [ "$OS_TYPE" = "debian" ] || [ "$OS_TYPE" = "raspbian" ]; then
		echo "Fail2Ban: installing and protecting SSH"
		${aptInstall("fail2ban")}
		if [ ! -f /etc/fail2ban/jail.local ]; then
			printf '[sshd]\\nenabled = true\\nmode = aggressive\\n' | $SUDO_CMD tee /etc/fail2ban/jail.local >/dev/null
		elif ! $SUDO_CMD grep -q '^\\[sshd\\]' /etc/fail2ban/jail.local; then
			printf '\\n[sshd]\\nenabled = true\\nmode = aggressive\\n' | $SUDO_CMD tee -a /etc/fail2ban/jail.local >/dev/null
		else
			echo "Fail2Ban: /etc/fail2ban/jail.local already has an [sshd] section, left unchanged."
		fi
		$SUDO_CMD systemctl enable --now fail2ban >/dev/null 2>&1
		$SUDO_CMD systemctl restart fail2ban
		echo "Fail2Ban is active ✅"
	else
		echo "Fail2Ban hardening supports Debian and Ubuntu only, skipped."
	fi
`;

const hardeningCommands = (hardening: ServerHardening) => `
${hardening.ufw ? hardenUfwCommand() : ""}
${hardening.ssh ? hardenSshCommand() : ""}
${hardening.fail2ban ? hardenFail2banCommand() : ""}
`;

export const serverHardeningStep = (
	hardening: ServerHardening,
	step: number,
) => {
	if (!hardening.ssh && !hardening.ufw && !hardening.fail2ban) {
		return "";
	}

	return `
echo -e "${step}. Applying security hardening"
${hardeningCommands(hardening)}
`;
};

const toHardening = (items: ServerHardeningItem[]): ServerHardening => ({
	ufw: items.includes("ufw"),
	ssh: items.includes("ssh"),
	fail2ban: items.includes("fail2ban"),
});

// Runs on its own, outside the setup script, so it detects the OS and sudo itself.
export const buildServerHardeningScript = (items: ServerHardeningItem[]) => {
	const hardening = toHardening(items);
	const needsApt = hardening.ufw || hardening.fail2ban;

	return `
set -e
if [ "$(id -u)" -eq 0 ]; then
	SUDO_CMD=""
elif sudo -n true 2>/dev/null; then
	SUDO_CMD="sudo"
else
	echo "Error: the SSH user needs root or passwordless sudo to change security settings. ❌" >&2
	exit 1
fi
OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
case "$OS_TYPE" in
pop | linuxmint | zorin) OS_TYPE="ubuntu" ;;
esac
echo "Operating system: $OS_TYPE"
${
	needsApt
		? `if [ "$OS_TYPE" = "ubuntu" ] || [ "$OS_TYPE" = "debian" ] || [ "$OS_TYPE" = "raspbian" ]; then
	echo "Updating package lists"
	$SUDO_CMD env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -qq >/dev/null
fi`
		: ""
}
${hardeningCommands(hardening)}
`;
};

export const hardenServer = async (
	serverId: string,
	items: ServerHardeningItem[],
	onData?: (data: string) => void,
) => {
	const deployment = await createServerDeployment({
		serverId,
		title: "Security hardening",
		description: `Security hardening: ${items.join(", ")}`,
	});
	const logFile = createWriteStream(deployment.logPath, { flags: "a" });
	const log = (data: string) => {
		logFile.write(data);
		onData?.(data);
	};

	try {
		log("\n");
		const { exitCode } = await runSshCommand(
			serverId,
			buildServerHardeningScript(items),
			log,
		);
		if (exitCode !== 0) {
			throw new Error(`Security hardening failed with exit code ${exitCode}`);
		}
		log(`\n${SERVER_HARDENING_DONE}\n`);
		await updateDeploymentStatus(deployment.deploymentId, "done");
	} catch (error) {
		logFile.write(
			`\n${error instanceof Error ? error.message : error}\n${SERVER_HARDENING_FAILED}\n`,
		);
		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	} finally {
		logFile.end();
	}
};
